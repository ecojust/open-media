use crate::engine::{self, Asset, MediaStore, Result, Runtime};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::Write,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const MAX_CHUNK: usize = 1024 * 1024;
const MAX_ASSET: u64 = 1024 * 1024 * 1024 * 1024;
const MAX_UPLOADS: usize = 4;
const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

struct Upload {
    file: tempfile::NamedTempFile,
    name: String,
    size: u64,
    received: u64,
    touched: Instant,
}

/// Only browser-owned media needs this bounded bridge. Existing native assets
/// go straight from their authorized disk paths into the project archive.
#[derive(Clone, Default)]
pub struct ProjectAssetUploads(Arc<Mutex<HashMap<String, Upload>>>);

#[derive(Serialize)]
pub struct UploadTicket {
    pub id: String,
}

impl ProjectAssetUploads {
    pub fn begin(&self, store: &MediaStore, name: String, size: u64) -> Result<UploadTicket> {
        if name.is_empty()
            || name.len() > 4000
            || name.chars().any(char::is_control)
            || size == 0
            || size > MAX_ASSET
        {
            return Err("项目素材名称或大小无效。".into());
        }
        let mut uploads = self.0.lock().map_err(|_| "项目素材传输状态不可用。")?;
        uploads.retain(|_, upload| upload.touched.elapsed() < IDLE_TIMEOUT);
        if uploads.len() >= MAX_UPLOADS {
            return Err("请等待当前项目素材传输完成后重试。".into());
        }
        let file = tempfile::Builder::new()
            .prefix(".project-upload-")
            .tempfile_in(&store.root)
            .map_err(|error| format!("无法准备项目素材：{error}"))?;
        let id = engine::new_id();
        uploads.insert(
            id.clone(),
            Upload {
                file,
                name,
                size,
                received: 0,
                touched: Instant::now(),
            },
        );
        Ok(UploadTicket { id })
    }

    pub fn write(&self, id: &str, offset: u64, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() || bytes.len() > MAX_CHUNK {
            return Err("项目素材分块大小无效。".into());
        }
        let mut uploads = self.0.lock().map_err(|_| "项目素材传输状态不可用。")?;
        uploads.retain(|_, upload| upload.touched.elapsed() < IDLE_TIMEOUT);
        let upload = uploads.get_mut(id).ok_or("项目素材传输已取消或过期。")?;
        if offset != upload.received || bytes.len() as u64 > upload.size - upload.received {
            return Err("项目素材分块顺序或长度不正确。".into());
        }
        if let Err(error) = upload.file.write_all(bytes) {
            uploads.remove(id);
            return Err(format!("项目素材写入失败，未覆盖项目文件：{error}"));
        }
        upload.received += bytes.len() as u64;
        upload.touched = Instant::now();
        Ok(())
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        self.0
            .lock()
            .map_err(|_| "项目素材传输状态不可用。")?
            .remove(id);
        Ok(())
    }

    pub fn finish(&self, id: &str, store: &MediaStore, runtime: &Runtime) -> Result<Asset> {
        let upload = self.take_complete(id)?;
        upload
            .file
            .as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        store.import(runtime, upload.file.path(), Some(&upload.name))
    }

    fn take_complete(&self, id: &str) -> Result<Upload> {
        let mut uploads = self.0.lock().map_err(|_| "项目素材传输状态不可用。")?;
        uploads.retain(|_, upload| upload.touched.elapsed() < IDLE_TIMEOUT);
        let upload = uploads.get(id).ok_or("项目素材传输已取消或过期。")?;
        if upload.received != upload.size {
            return Err("项目素材尚未传输完整。".into());
        }
        Ok(uploads.remove(id).expect("checked upload"))
    }
}

pub fn packet_offset(packet: &[u8]) -> Result<u64> {
    if !(9..=MAX_CHUNK + 8).contains(&packet.len()) {
        return Err("项目素材分块大小无效。".into());
    }
    Ok(u64::from_le_bytes(
        packet[..8].try_into().expect("checked header"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn chunked_upload_is_ordered_bounded_and_cancel_removes_temporary_media() {
        let root = tempfile::tempdir().unwrap();
        let store = MediaStore::new(root.path()).unwrap();
        let uploads = ProjectAssetUploads::default();
        let ticket = uploads.begin(&store, "字幕配音.wav".into(), 6).unwrap();
        assert!(uploads.write(&ticket.id, 1, b"abc").is_err());
        uploads.write(&ticket.id, 0, b"abc").unwrap();
        assert!(uploads.take_complete(&ticket.id).is_err());
        assert!(uploads.write(&ticket.id, 0, b"abc").is_err());
        assert!(uploads.write(&ticket.id, 3, b"abcd").is_err());
        uploads.write(&ticket.id, 3, b"def").unwrap();
        let completed = uploads.take_complete(&ticket.id).unwrap();
        assert_eq!(fs::read(completed.file.path()).unwrap(), b"abcdef");
        drop(completed);
        let cancelled = uploads
            .begin(&store, "片段.mp4".into(), 300 * 1024 * 1024)
            .unwrap();
        uploads.write(&cancelled.id, 0, b"data").unwrap();
        uploads.cancel(&cancelled.id).unwrap();
        assert!(uploads.write(&cancelled.id, 4, b"data").is_err());
        assert_eq!(fs::read_dir(&store.root).unwrap().count(), 0);
        assert!(uploads.begin(&store, "empty.mp4".into(), 0).is_err());
    }

    #[test]
    fn packet_rejects_large_empty_and_truncated_chunks() {
        for size in [0, 7, 8, MAX_CHUNK + 9] {
            assert!(packet_offset(&vec![0; size]).is_err());
        }
        let mut packet = (5_u64 * 1024 * 1024 * 1024).to_le_bytes().to_vec();
        packet.extend_from_slice(b"frame");
        assert_eq!(packet_offset(&packet).unwrap(), 5 * 1024 * 1024 * 1024);
    }

    #[test]
    fn abandoned_uploads_expire_and_do_not_exhaust_slots() {
        let root = tempfile::tempdir().unwrap();
        let store = MediaStore::new(root.path()).unwrap();
        let uploads = ProjectAssetUploads::default();
        for _ in 0..MAX_UPLOADS {
            uploads.begin(&store, "片段.mp4".into(), 1).unwrap();
        }
        assert!(uploads.begin(&store, "片段.mp4".into(), 1).is_err());
        for upload in uploads.0.lock().unwrap().values_mut() {
            upload.touched = Instant::now() - IDLE_TIMEOUT;
        }
        let ticket = uploads.begin(&store, "片段.mp4".into(), 1).unwrap();
        assert_eq!(fs::read_dir(&store.root).unwrap().count(), 1);
        uploads.cancel(&ticket.id).unwrap();
    }
}
