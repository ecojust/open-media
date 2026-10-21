//! Read one bounded source-media block without copying or decoding the file.
use super::{integer, TaskControl};
use crate::engine::{MediaStore, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, Metadata},
    io::{Read, Seek, SeekFrom},
    time::UNIX_EPOCH,
};

const MAX_READ: u64 = 256 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn version(asset_id: &str, metadata: &Metadata) -> Result<String> {
    let modified = metadata
        .modified()
        .map_err(|_| "无法检查素材文件版本。")?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "素材文件时间无效。")?
        .as_nanos();
    let created = metadata
        .created()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos());
    Ok(format!(
        "{:x}",
        Sha256::digest(format!("{asset_id}:{}:{modified}:{created:?}", metadata.len()).as_bytes())
    ))
}

pub fn read_asset_chunk(
    store: &MediaStore,
    asset: &Value,
    args: &Value,
    control: &TaskControl,
) -> Result<Value> {
    control.check()?;
    let id = asset
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .ok_or("素材标识无效。")?;
    let offset = integer(args, "offset", 0)?;
    let length = integer(args, "length", MAX_READ)?;
    if offset > MAX_SAFE_INTEGER || length == 0 || length > MAX_READ {
        return Err("素材读取位置或分块长度无效。".into());
    }
    let expected = args
        .get("sourceVersion")
        .map(|value| {
            value
                .as_str()
                .filter(|value| {
                    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or("素材文件版本格式无效。")
        })
        .transpose()?;
    if offset > 0 && expected.is_none() {
        return Err("续传素材需要首块返回的 sourceVersion，请从 offset=0 重新读取。".into());
    }
    let path = store.authorized_path(asset)?;
    let mut file = File::open(&path).map_err(|_| "无法读取素材文件，请重新导入。")?;
    let metadata = file.metadata().map_err(|_| "无法读取素材文件信息。")?;
    if !metadata.is_file() || metadata.len() > MAX_SAFE_INTEGER {
        return Err("素材文件大小超出读取范围。".into());
    }
    let source_version = version(id, &metadata)?;
    if expected.is_some_and(|expected| expected != source_version) {
        return Err("素材文件已变化，请重新读取工程并从 offset=0 开始下载。".into());
    }
    if offset > metadata.len() {
        return Err("读取位置超出素材文件。".into());
    }
    let size = length.min(metadata.len() - offset) as usize;
    let mut bytes = vec![0; size];
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| "无法定位素材读取位置。")?;
    file.read_exact(&mut bytes)
        .map_err(|_| "素材读取不完整，请重新开始下载。")?;
    control.check()?;
    let after = file.metadata().map_err(|_| "无法复核素材文件版本。")?;
    // Also recheck the named entry: replacing the source must not resume an old handle.
    let entry = std::fs::metadata(&path).map_err(|_| "素材文件已变化，请重新开始下载。")?;
    if version(id, &after)? != source_version || version(id, &entry)? != source_version {
        return Err("素材文件在读取过程中已变化，请从 offset=0 重新开始下载。".into());
    }
    let next = offset + size as u64;
    Ok(json!({
        "assetId": id, "name": asset.get("name").and_then(Value::as_str).unwrap_or("素材"),
        "mimeType": asset.get("mime").and_then(Value::as_str).unwrap_or("application/octet-stream"),
        "sourceVersion": source_version, "totalBytes": metadata.len(), "offset": offset,
        "nextOffset": next, "done": next == metadata.len(), "encoding": "base64",
        "chunkSha256": format!("{:x}", Sha256::digest(&bytes)), "data": STANDARD.encode(&bytes),
        "maxChunkBytes": MAX_READ,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn source_blocks_round_trip_without_exporting_paths_or_copying_whole_media() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let path = store.root.join("source.mp4");
        let bytes: Vec<u8> = (0..MAX_READ as usize * 2 + 19)
            .map(|index| (index % 251) as u8)
            .collect();
        std::fs::write(&path, &bytes).unwrap();
        let asset = json!({"id":"source","name":"示例.mp4","mime":"video/mp4","nativePath":path});
        let control = TaskControl::new(Duration::from_secs(5));
        let mut offset = 0;
        let mut source_version: Option<String> = None;
        let mut downloaded = vec![];
        loop {
            let mut args = json!({"offset":offset});
            if let Some(ref value) = source_version {
                args["sourceVersion"] = Value::String(value.clone());
            }
            let result = read_asset_chunk(&store, &asset, &args, &control).unwrap();
            assert!(!result.to_string().contains("nativePath"));
            assert!(!result
                .to_string()
                .contains(directory.path().to_str().unwrap()));
            let chunk = STANDARD.decode(result["data"].as_str().unwrap()).unwrap();
            assert!(chunk.len() <= MAX_READ as usize);
            assert_eq!(
                result["chunkSha256"],
                format!("{:x}", Sha256::digest(&chunk))
            );
            downloaded.extend(chunk);
            source_version = Some(result["sourceVersion"].as_str().unwrap().to_string());
            offset = result["nextOffset"].as_u64().unwrap();
            if result["done"] == true {
                break;
            }
        }
        assert_eq!(downloaded, bytes);
        assert_eq!(std::fs::read_dir(&store.root).unwrap().count(), 1);
        let eof = read_asset_chunk(
            &store,
            &asset,
            &json!({"offset":bytes.len(),"sourceVersion":source_version}),
            &control,
        )
        .unwrap();
        assert_eq!(eof["done"], true);
        assert_eq!(eof["data"], "");
        std::fs::write(&path, b"replacement").unwrap();
        assert!(read_asset_chunk(
            &store,
            &asset,
            &json!({"offset":1,"sourceVersion":source_version}),
            &control
        )
        .unwrap_err()
        .contains("已变化"));
    }

    #[test]
    fn source_read_rejects_bad_ranges_versions_and_outside_paths() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let path = store.root.join("source.png");
        std::fs::write(&path, [1, 2, 3]).unwrap();
        let asset = json!({"id":"source","nativePath":path});
        let control = TaskControl::new(Duration::from_secs(5));
        for args in [
            json!({"offset":-1}),
            json!({"offset":1}),
            json!({"length":0}),
            json!({"length":MAX_READ+1}),
            json!({"offset":MAX_SAFE_INTEGER+1}),
            json!({"sourceVersion":"wrong"}),
            json!({"offset":4,"sourceVersion":"0".repeat(64)}),
        ] {
            assert!(
                read_asset_chunk(&store, &asset, &args, &control).is_err(),
                "{args}"
            );
        }
        let outside = tempfile::NamedTempFile::new().unwrap();
        let result = read_asset_chunk(
            &store,
            &json!({"id":"outside","nativePath":outside.path()}),
            &json!({}),
            &control,
        );
        assert!(result.unwrap_err().contains("素材库"));
        control
            .cancelled
            .store(true, std::sync::atomic::Ordering::Release);
        assert!(read_asset_chunk(&store, &asset, &json!({}), &control)
            .unwrap_err()
            .contains("取消"));
    }
}
