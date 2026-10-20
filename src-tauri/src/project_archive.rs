//! Portable projects use the same versioned ZIP manifest on every platform.
//! Media is copied with a fixed buffer; only the bounded JSON manifest is in memory.
use crate::engine::{new_id, MediaStore, Result};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const MANIFEST: &str = "project.json";
const MAX_MANIFEST: u64 = 5 * 1024 * 1024;
const MAX_ASSETS: usize = 1000;
const MAX_DIRECTORY: u64 = 4 * 1024 * 1024;
// A resource limit, independent of browser memory. Check free disk space before extraction.
const MAX_MEDIA_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
const COPY_BUFFER: usize = 64 * 1024;
const DISK_RESERVE: u64 = 16 * 1024 * 1024;
const INVALID_ARCHIVE: &str = "项目文件目录损坏或包含不支持的格式。";

type PendingImports = HashMap<PathBuf, HashSet<PathBuf>>;
static PENDING_IMPORTS: OnceLock<Mutex<PendingImports>> = OnceLock::new();

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_entry(name: &str) -> bool {
    name == MANIFEST || name.strip_prefix("media/").is_some_and(valid_id)
}

fn clean_project(project: &Value) -> Result<Value> {
    let root = project.as_object().ok_or("项目描述格式无效。")?;
    if root.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("暂不支持此项目版本。".into());
    }
    let assets = root
        .get("assets")
        .and_then(Value::as_array)
        .ok_or("项目素材列表无效。")?;
    let tracks = root
        .get("tracks")
        .and_then(Value::as_array)
        .ok_or("项目轨道列表无效。")?;
    if assets.len() > MAX_ASSETS || tracks.len() > 100 {
        return Err("项目素材或轨道数量过多。".into());
    }
    let mut clip_count = 0_usize;
    for track in tracks {
        clip_count += track
            .get("clips")
            .and_then(Value::as_array)
            .ok_or("项目片段列表无效。")?
            .len();
        if clip_count > 10000 {
            return Err("项目片段数量过多。".into());
        }
    }
    // A document must never carry a save token or a machine-specific save target.
    let mut clean = Map::new();
    for key in [
        "version",
        "id",
        "title",
        "width",
        "height",
        "fps",
        "background",
        "createdAt",
        "updatedAt",
        "tracks",
        "markers",
        "autoSizeFromVideo",
        "subtitleStyle",
    ] {
        if let Some(value) = root.get(key) {
            clean.insert(key.into(), value.clone());
        }
    }
    let mut ids = HashSet::new();
    let mut clean_assets = Vec::with_capacity(assets.len());
    for asset in assets {
        let source = asset.as_object().ok_or("素材描述格式无效。")?;
        let id = source
            .get("id")
            .and_then(Value::as_str)
            .ok_or("素材标识无效。")?;
        if !valid_id(id) || !ids.insert(id) {
            return Err("项目包含无效或重复的素材标识。".into());
        }
        if !matches!(
            source.get("kind").and_then(Value::as_str),
            Some("image" | "audio" | "video")
        ) {
            return Err("素材类型无效。".into());
        }
        let mut clean_asset = Map::new();
        for key in [
            "id",
            "name",
            "kind",
            "duration",
            "width",
            "height",
            "size",
            "mime",
            "provenance",
            "compression",
            "addedAt",
            "libraryRole",
        ] {
            if let Some(value) = source.get(key) {
                clean_asset.insert(key.into(), value.clone());
            }
        }
        clean_asset.insert("url".into(), Value::String(String::new()));
        clean_assets.push(Value::Object(clean_asset));
    }
    clean.insert("assets".into(), Value::Array(clean_assets));
    Ok(Value::Object(clean))
}

struct BoundedJson(Vec<u8>);
impl Write for BoundedJson {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) as u64 > MAX_MANIFEST {
            return Err(io::Error::other("项目描述过大，请减少字幕或片段数量。"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn manifest_bytes(project: &Value) -> Result<Vec<u8>> {
    let mut bytes = BoundedJson(Vec::new());
    serde_json::to_writer(
        &mut bytes,
        &json!({"format":"open-media-project", "version":1, "project":project}),
    )
    .map_err(|error| format!("无法保存项目描述：{error}"))?;
    Ok(bytes.0)
}

/// Save original local media, never a browser URL or a preview proxy.
pub fn write_archive(writer: &mut File, store: &MediaStore, project: &Value) -> Result<()> {
    let mut clean = clean_project(project)?;
    let source_assets = project["assets"].as_array().ok_or("项目素材列表无效。")?;
    let mut files = Vec::with_capacity(source_assets.len());
    let mut total = 0_u64;
    for (source, asset) in source_assets
        .iter()
        .zip(clean["assets"].as_array_mut().unwrap())
    {
        let path = store.authorized_path(source)?;
        let metadata = fs::metadata(&path).map_err(|error| format!("无法读取素材：{error}"))?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err("项目包含空白或不可读取的素材。".into());
        }
        total = total
            .checked_add(metadata.len())
            .ok_or("项目素材总大小无效。")?;
        if total > MAX_MEDIA_BYTES {
            return Err("项目素材超过 1 TB 磁盘容量限制。".into());
        }
        asset["size"] = metadata.len().into();
        files.push((path, metadata.len(), metadata.modified().ok()));
    }
    let manifest = manifest_bytes(&clean)?;
    let mut archive = ZipWriter::new(writer);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o600);
    archive
        .start_file(MANIFEST, options)
        .map_err(|error| error.to_string())?;
    archive
        .write_all(&manifest)
        .map_err(|error| error.to_string())?;
    for (asset, (path, size, modified)) in clean["assets"].as_array().unwrap().iter().zip(files) {
        let mut source = File::open(&path).map_err(|error| format!("无法读取素材：{error}"))?;
        let metadata = source.metadata().map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.len() != size || metadata.modified().ok() != modified {
            return Err("素材在保存期间已变化，请重新保存。".into());
        }
        let name = format!("media/{}", asset["id"].as_str().unwrap());
        archive
            .start_file(name, options.large_file(size >= u32::MAX as u64))
            .map_err(|error| error.to_string())?;
        copy_exact(&mut source, &mut archive, size)?;
        if source
            .metadata()
            .map_err(|error| error.to_string())?
            .modified()
            .ok()
            != modified
        {
            return Err("素材在保存期间已变化，请重新保存。".into());
        }
    }
    archive
        .finish()
        .map_err(|error| format!("无法完成项目保存：{error}"))?;
    Ok(())
}

fn copy_exact(reader: &mut impl Read, writer: &mut impl Write, size: u64) -> Result<()> {
    let mut buffer = [0_u8; COPY_BUFFER];
    let mut remaining = size;
    while remaining != 0 {
        let length = remaining.min(buffer.len() as u64) as usize;
        let read = reader
            .read(&mut buffer[..length])
            .map_err(|error| format!("素材读取或校验失败：{error}"))?;
        if read == 0 {
            return Err("项目素材长度不符，文件可能已损坏。".into());
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| format!("无法保存素材，请检查磁盘空间：{error}"))?;
        remaining -= read as u64;
    }
    // Reading through EOF also triggers the ZIP reader's CRC validation.
    if reader
        .read(&mut buffer[..1])
        .map_err(|error| format!("素材校验失败：{error}"))?
        != 0
    {
        return Err("项目素材长度不符，文件可能已损坏。".into());
    }
    Ok(())
}

#[derive(Debug)]
struct Entry {
    name: String,
    size: u64,
    compressed: u64,
    offset: u64,
    data: u64,
    crc: u32,
}

fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
}
fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

fn read_at(file: &mut File, offset: u64, bytes: &mut [u8]) -> Result<()> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    file.read_exact(bytes)
        .map_err(|_| INVALID_ARCHIVE.to_string())
}

fn zip64_values(extra: &[u8], requested: &[bool]) -> Result<Vec<u64>> {
    let mut offset = 0;
    let mut values = None;
    while offset < extra.len() {
        if offset + 4 > extra.len() {
            return Err(INVALID_ARCHIVE.into());
        }
        let kind = u16_at(extra, offset);
        let length = u16_at(extra, offset + 2) as usize;
        offset += 4;
        if offset + length > extra.len() {
            return Err(INVALID_ARCHIVE.into());
        }
        if kind == 1 {
            if values.is_some() {
                return Err(INVALID_ARCHIVE.into());
            }
            let needed = requested.iter().filter(|needed| **needed).count() * 8;
            if length < needed {
                return Err(INVALID_ARCHIVE.into());
            }
            values = Some(
                (0..needed / 8)
                    .map(|index| u64_at(extra, offset + index * 8))
                    .collect(),
            );
        }
        // Alternative Unicode names can disagree with the strict raw archive path.
        if kind == 0x7075 {
            return Err("项目包含不一致的素材路径。".into());
        }
        offset += length;
    }
    if requested.iter().any(|needed| *needed) {
        values.ok_or(INVALID_ARCHIVE.into())
    } else {
        Ok(Vec::new())
    }
}

/// Bound central-directory allocation before constructing the general ZIP reader.
fn inspect_archive(file: &mut File) -> Result<Vec<Entry>> {
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    if !(22..=MAX_MEDIA_BYTES + MAX_MANIFEST + MAX_DIRECTORY).contains(&length) {
        return Err("项目文件为空、损坏或超过 1 TB 磁盘容量限制。".into());
    }
    let tail_start = length.saturating_sub(65557);
    let mut tail = vec![0; (length - tail_start) as usize];
    read_at(file, tail_start, &mut tail)?;
    let end = (0..=tail.len() - 22)
        .rev()
        .find(|offset| {
            u32_at(&tail, *offset) == 0x06054b50
                && *offset + 22 + u16_at(&tail, *offset + 20) as usize == tail.len()
        })
        .ok_or(INVALID_ARCHIVE)?;
    let end_at = tail_start + end as u64;
    let eocd = &tail[end..];
    if u16_at(eocd, 4) != 0 || u16_at(eocd, 6) != 0 || u16_at(eocd, 8) != u16_at(eocd, 10) {
        return Err("不支持分卷项目文件。".into());
    }
    let mut count = u16_at(eocd, 10) as u64;
    let mut directory_size = u32_at(eocd, 12) as u64;
    let mut directory_offset = u32_at(eocd, 16) as u64;
    let mut directory_end = end_at;
    if count == u16::MAX as u64
        || directory_size == u32::MAX as u64
        || directory_offset == u32::MAX as u64
    {
        let mut locator = [0; 20];
        read_at(
            file,
            end_at.checked_sub(20).ok_or(INVALID_ARCHIVE)?,
            &mut locator,
        )?;
        if u32_at(&locator, 0) != 0x07064b50
            || u32_at(&locator, 4) != 0
            || u32_at(&locator, 16) != 1
        {
            return Err(INVALID_ARCHIVE.into());
        }
        let zip64_offset = u64_at(&locator, 8);
        let mut record = [0; 56];
        read_at(file, zip64_offset, &mut record)?;
        let record_length = u64_at(&record, 4);
        if u32_at(&record, 0) != 0x06064b50
            || !(44..=65536).contains(&record_length)
            || zip64_offset.checked_add(12 + record_length) != end_at.checked_sub(20)
            || u32_at(&record, 16) != 0
            || u32_at(&record, 20) != 0
            || u64_at(&record, 24) != u64_at(&record, 32)
        {
            return Err(INVALID_ARCHIVE.into());
        }
        count = u64_at(&record, 32);
        directory_size = u64_at(&record, 40);
        directory_offset = u64_at(&record, 48);
        directory_end = zip64_offset;
    }
    if count == 0
        || count > (MAX_ASSETS + 1) as u64
        || directory_size > MAX_DIRECTORY
        || directory_offset.checked_add(directory_size) != Some(directory_end)
    {
        return Err(INVALID_ARCHIVE.into());
    }
    let mut entries = Vec::with_capacity(count as usize);
    let mut names = HashSet::new();
    let mut position = directory_offset;
    let mut total = 0_u64;
    for _ in 0..count {
        if position
            .checked_add(46)
            .is_none_or(|end| end > directory_end)
        {
            return Err(INVALID_ARCHIVE.into());
        }
        let mut header = [0; 46];
        read_at(file, position, &mut header)?;
        if u32_at(&header, 0) != 0x02014b50 || u16_at(&header, 34) != 0 {
            return Err(INVALID_ARCHIVE.into());
        }
        let flags = u16_at(&header, 8);
        let method = u16_at(&header, 10);
        let name_len = u16_at(&header, 28) as usize;
        let extra_len = u16_at(&header, 30) as usize;
        let comment_len = u16_at(&header, 32) as u64;
        let next = position
            .checked_add(46 + name_len as u64 + extra_len as u64 + comment_len)
            .ok_or(INVALID_ARCHIVE)?;
        if next > directory_end
            || name_len > 166
            || flags & (1 | 64 | 8192) != 0
            || !matches!(method, 0 | 8)
        {
            return Err("项目包含加密或不支持的素材格式。".into());
        }
        let mode = u32_at(&header, 38) >> 16;
        if mode & 0o170000 != 0 && mode & 0o170000 != 0o100000 {
            return Err("项目不允许包含链接或特殊文件。".into());
        }
        let mut variable = vec![0; name_len + extra_len];
        read_at(file, position + 46, &mut variable)?;
        let name = std::str::from_utf8(&variable[..name_len])
            .map_err(|_| INVALID_ARCHIVE)?
            .to_owned();
        if !valid_entry(&name) || !names.insert(name.clone()) {
            return Err("项目包含无效或重复的素材路径。".into());
        }
        let mut size = u32_at(&header, 24) as u64;
        let mut compressed = u32_at(&header, 20) as u64;
        let mut offset = u32_at(&header, 42) as u64;
        let requested = [
            size == u32::MAX as u64,
            compressed == u32::MAX as u64,
            offset == u32::MAX as u64,
        ];
        let mut values = zip64_values(&variable[name_len..], &requested)?.into_iter();
        if requested[0] {
            size = values.next().ok_or(INVALID_ARCHIVE)?;
        }
        if requested[1] {
            compressed = values.next().ok_or(INVALID_ARCHIVE)?;
        }
        if requested[2] {
            offset = values.next().ok_or(INVALID_ARCHIVE)?;
        }
        if (name == MANIFEST && size > MAX_MANIFEST)
            || size == 0
            || (method == 0 && size != compressed)
        {
            return Err("项目描述过大或素材大小不一致。".into());
        }
        total = total.checked_add(size).ok_or(INVALID_ARCHIVE)?;
        if total > MAX_MEDIA_BYTES + MAX_MANIFEST {
            return Err("项目展开后超过 1 TB 磁盘容量限制。".into());
        }
        let mut local = [0; 30];
        if offset
            .checked_add(30)
            .is_none_or(|end| end > directory_offset)
        {
            return Err(INVALID_ARCHIVE.into());
        }
        read_at(file, offset, &mut local)?;
        let local_name_len = u16_at(&local, 26) as usize;
        let local_extra_len = u16_at(&local, 28) as usize;
        let data = offset + 30 + local_name_len as u64 + local_extra_len as u64;
        if u32_at(&local, 0) != 0x04034b50
            || u16_at(&local, 6) != flags
            || u16_at(&local, 8) != method
            || local_name_len != name_len
            || data
                .checked_add(compressed)
                .is_none_or(|end| end > directory_offset)
        {
            return Err("项目素材索引不一致。".into());
        }
        let mut local_variable = vec![0; local_name_len + local_extra_len];
        read_at(file, offset + 30, &mut local_variable)?;
        if local_variable[..local_name_len] != *name.as_bytes() {
            return Err("项目素材路径不一致。".into());
        }
        let mut local_size = u32_at(&local, 22) as u64;
        let mut local_compressed = u32_at(&local, 18) as u64;
        let local_requested = [
            local_size == u32::MAX as u64,
            local_compressed == u32::MAX as u64,
        ];
        let mut local_values =
            zip64_values(&local_variable[local_name_len..], &local_requested)?.into_iter();
        if local_requested[0] {
            local_size = local_values.next().ok_or(INVALID_ARCHIVE)?;
        }
        if local_requested[1] {
            local_compressed = local_values.next().ok_or(INVALID_ARCHIVE)?;
        }
        let crc = u32_at(&header, 16);
        if flags & 8 == 0
            && (local_size != size || local_compressed != compressed || u32_at(&local, 14) != crc)
        {
            return Err("项目素材长度或校验信息不一致。".into());
        }
        entries.push(Entry {
            name,
            size,
            compressed,
            offset,
            data,
            crc,
        });
        position = next;
    }
    if position != directory_end || !names.contains(MANIFEST) {
        return Err("项目文件缺少描述信息。".into());
    }
    let mut intervals: Vec<_> = entries
        .iter()
        .map(|entry| (entry.offset, entry.data + entry.compressed))
        .collect();
    intervals.sort_unstable();
    for adjacent in intervals.windows(2) {
        if adjacent[1].0 < adjacent[0].1 {
            return Err("项目素材数据存在重叠。".into());
        }
    }
    Ok(entries)
}

fn checked_media_root(store: &MediaStore) -> Result<&Path> {
    let metadata = fs::symlink_metadata(&store.root).map_err(|error| error.to_string())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || store
            .root
            .canonicalize()
            .map_err(|error| error.to_string())?
            != store.root
    {
        return Err("媒体保存目录已改变，请重新打开应用。".into());
    }
    Ok(&store.root)
}

/// Extract into a newly created private directory. Every failure removes the staging tree.
pub fn read_archive(store: &MediaStore, path: &Path) -> Result<Value> {
    checked_media_root(store)?;
    let mut file = File::open(path).map_err(|error| format!("无法读取项目：{error}"))?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("请选择本机项目文件。".into());
    }
    let entries = inspect_archive(&mut file)?;
    let total: u64 = entries
        .iter()
        .filter(|entry| entry.name != MANIFEST)
        .map(|entry| entry.size)
        .sum();
    crate::ai_models::require_space(&store.root, total.saturating_add(DISK_RESERVE))
        .map_err(|error| error.replace("模型目录", "项目素材目录"))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("项目目录校验失败：{error}"))?;
    if archive.len() != entries.len() || archive.offset() != 0 {
        return Err(INVALID_ARCHIVE.into());
    }
    for entry in &entries {
        let item = archive
            .by_name(&entry.name)
            .map_err(|error| error.to_string())?;
        if item.name_raw() != entry.name.as_bytes()
            || item.size() != entry.size
            || item.compressed_size() != entry.compressed
            || item.header_start() != entry.offset
            || item.data_start() != entry.data
            || item.crc32() != entry.crc
            || item.encrypted()
            || item.is_symlink()
            || item.is_dir()
            || !matches!(
                item.compression(),
                CompressionMethod::Stored | CompressionMethod::Deflated
            )
        {
            return Err(INVALID_ARCHIVE.into());
        }
    }
    let manifest_size = entries
        .iter()
        .find(|entry| entry.name == MANIFEST)
        .unwrap()
        .size;
    let mut bytes = Vec::with_capacity(manifest_size as usize);
    copy_exact(
        &mut archive
            .by_name(MANIFEST)
            .map_err(|error| error.to_string())?,
        &mut bytes,
        manifest_size,
    )?;
    let manifest: Value =
        serde_json::from_slice(&bytes).map_err(|_| "项目描述不是有效的 JSON 数据。")?;
    if manifest["format"] != "open-media-project" || manifest["version"].as_u64() != Some(1) {
        return Err("此文件不是受支持的便携项目。".into());
    }
    let mut project = clean_project(&manifest["project"])?;
    let assets = project["assets"].as_array_mut().unwrap();
    if entries.len() != assets.len() + 1 {
        return Err("项目素材清单与文件内容不一致。".into());
    }
    for asset in assets.iter() {
        let name = format!("media/{}", asset["id"].as_str().unwrap());
        let entry = entries
            .iter()
            .find(|entry| entry.name == name)
            .ok_or("项目素材缺失。")?;
        if asset["size"].as_u64() != Some(entry.size) {
            return Err("项目素材大小与清单不一致。".into());
        }
    }
    if assets.is_empty() {
        return Ok(project);
    }
    let staging = tempfile::Builder::new()
        .prefix(&format!("project-{}-", new_id()))
        .tempdir_in(&store.root)
        .map_err(|error| format!("无法创建项目素材目录：{error}"))?;
    let mut paths = HashSet::new();
    for asset in assets {
        let id = asset["id"].as_str().unwrap();
        let name = format!("media/{id}");
        let extension = Path::new(asset["name"].as_str().unwrap_or_default())
            .extension()
            .and_then(|value| value.to_str())
            .filter(|extension| {
                !extension.is_empty()
                    && extension.len() <= 12
                    && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
            });
        // Preview caches use the media filename as their key. Never reuse an asset ID
        // here: two saved revisions may keep that ID while containing different bytes.
        let filename = new_id();
        let output_path = staging.path().join(
            extension
                .map(|extension| format!("{filename}.{extension}"))
                .unwrap_or(filename),
        );
        let mut output = File::create(&output_path).map_err(|error| error.to_string())?;
        copy_exact(
            &mut archive.by_name(&name).map_err(|error| error.to_string())?,
            &mut output,
            asset["size"].as_u64().unwrap(),
        )?;
        output.sync_all().map_err(|error| error.to_string())?;
        asset["nativePath"] = output_path.to_string_lossy().into_owned().into();
        paths.insert(output_path);
    }
    let mut pending = PENDING_IMPORTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "项目导入状态不可用。")?;
    pending.insert(staging.path().to_owned(), paths);
    let _ = staging.keep();
    Ok(project)
}

fn finish_import(store: &MediaStore, project: &Value, keep: bool) -> Result<()> {
    checked_media_root(store)?;
    let assets = project["assets"].as_array().ok_or("项目素材列表无效。")?;
    if assets.is_empty() {
        return Ok(());
    }
    let paths: HashSet<PathBuf> = assets
        .iter()
        .map(|asset| {
            asset["nativePath"]
                .as_str()
                .map(PathBuf::from)
                .ok_or("项目导入凭据无效。".to_owned())
        })
        .collect::<Result<_>>()?;
    let directory = paths
        .iter()
        .next()
        .and_then(|path| path.parent())
        .ok_or("项目导入凭据无效。")?;
    if directory.parent() != Some(store.root.as_path())
        || paths.iter().any(|path| path.parent() != Some(directory))
    {
        return Err("项目导入凭据无效。".into());
    }
    let mut pending = PENDING_IMPORTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "项目导入状态不可用。")?;
    if pending.get(directory) != Some(&paths) {
        return Err("项目导入凭据已失效。".into());
    }
    if !keep {
        fs::remove_dir_all(directory)
            .map_err(|error| format!("无法清理未完成的项目导入：{error}"))?;
    }
    pending.remove(directory);
    Ok(())
}

pub fn accept_imported(store: &MediaStore, project: &Value) -> Result<()> {
    finish_import(store, project, true)
}
pub fn discard_imported(store: &MediaStore, project: &Value) -> Result<()> {
    finish_import(store, project, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_files::ProjectFiles;
    static LARGE_FILES: Mutex<()> = Mutex::new(());

    fn project(store: &MediaStore, bytes: &[u8]) -> Value {
        let source = store.root.join("source.mp4");
        fs::write(&source, bytes).unwrap();
        json!({
            "version":1, "id":"project-test", "title":"中文项目", "width":1920, "height":1080, "fps":30,
            "tracks":[{"id":"video-track", "kind":"video", "clips":[]}],
            "assets":[{"id":"asset-one", "name":"录屏.mp4", "kind":"video", "size":bytes.len(),
                "url":"asset://not-portable", "sourceUrl":"blob:not-portable", "nativePath":source,
                "width":1920, "height":1080, "duration":10, "mime":"video/mp4"}],
            "token":"never-portable", "saveTarget":{"path":"/private/project.omedia", "token":"secret"}
        })
    }

    fn raw_archive(
        path: &Path,
        project: &Value,
        media: &[u8],
        zip64: bool,
        compression: CompressionMethod,
    ) {
        let file = File::create(path).unwrap();
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(compression)
            .large_file(zip64);
        archive.start_file(MANIFEST, options).unwrap();
        archive
            .write_all(&manifest_bytes(project).unwrap())
            .unwrap();
        archive.start_file("media/asset-one", options).unwrap();
        archive.write_all(media).unwrap();
        archive.finish().unwrap();
    }

    fn staging_count(store: &MediaStore) -> usize {
        fs::read_dir(&store.root)
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("project-"))
            .count()
    }

    #[test]
    fn round_trip_scrubs_credentials_and_paths_then_reads_only_private_media() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let source = project(&store, b"original source media");
        let path = directory.path().join("round-trip.omedia");
        write_archive(&mut File::create(&path).unwrap(), &store, &source).unwrap();
        let mut zip = ZipArchive::new(File::open(&path).unwrap()).unwrap();
        let mut manifest = String::new();
        zip.by_name(MANIFEST)
            .unwrap()
            .read_to_string(&mut manifest)
            .unwrap();
        let saved: Value = serde_json::from_str(&manifest).unwrap();
        assert_eq!(saved["project"]["assets"][0]["url"], "");
        for key in ["nativePath", "sourceUrl"] {
            assert!(saved["project"]["assets"][0].get(key).is_none());
        }
        for key in ["token", "saveTarget"] {
            assert!(saved["project"].get(key).is_none());
        }
        drop(zip);
        fs::remove_file(source["assets"][0]["nativePath"].as_str().unwrap()).unwrap();
        let loaded = read_archive(&store, &path).unwrap();
        assert_eq!(loaded["title"], "中文项目");
        let media = store.authorized_path(&loaded["assets"][0]).unwrap();
        assert_eq!(fs::read(&media).unwrap(), b"original source media");
        accept_imported(&store, &loaded).unwrap();
        assert!(discard_imported(&store, &loaded).is_err());
        assert!(media.exists());
    }

    #[test]
    fn reopening_revisions_with_same_asset_id_cannot_reuse_preview_cache_filename() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let source = project(&store, b"first revision");
        let path = directory.path().join("revisions.omedia");
        raw_archive(
            &path,
            &source,
            b"first revision",
            false,
            CompressionMethod::Stored,
        );
        let first = read_archive(&store, &path).unwrap();
        let mut revised = source.clone();
        revised["assets"][0]["size"] = 15.into();
        raw_archive(
            &path,
            &revised,
            b"second revision",
            false,
            CompressionMethod::Stored,
        );
        let second = read_archive(&store, &path).unwrap();
        let first_path = store.authorized_path(&first["assets"][0]).unwrap();
        let second_path = store.authorized_path(&second["assets"][0]).unwrap();
        assert_eq!(first["assets"][0]["id"], second["assets"][0]["id"]);
        assert_ne!(first_path.file_name(), second_path.file_name());
        assert_eq!(fs::read(first_path).unwrap(), b"first revision");
        assert_eq!(fs::read(second_path).unwrap(), b"second revision");
        discard_imported(&store, &first).unwrap();
        discard_imported(&store, &second).unwrap();
    }

    #[test]
    fn legacy_deflate_and_small_zip64_archives_are_compatible() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let source = project(&store, b"compatible media");
        for (zip64, method) in [
            (false, CompressionMethod::Deflated),
            (true, CompressionMethod::Stored),
            (true, CompressionMethod::Deflated),
        ] {
            let path = directory.path().join("legacy.omedia");
            raw_archive(&path, &source, b"compatible media", zip64, method);
            let loaded = read_archive(&store, &path).unwrap();
            assert_eq!(
                fs::read(store.authorized_path(&loaded["assets"][0]).unwrap()).unwrap(),
                b"compatible media"
            );
            discard_imported(&store, &loaded).unwrap();
            assert_eq!(staging_count(&store), 0);
        }
    }

    #[test]
    fn reads_existing_browser_writer_fixture() {
        use base64::Engine;
        // Produced by the existing fflate level-0 writer, with media before its manifest.
        let fixture = "UEsDBBQAAAAAAAAAIVgMoSxqBQAAAAUAAAAPAAAAbWVkaWEvYXNzZXQtb25lbWVkaWFQSwMEFAAAAAAAAAAhWNytJsoyAQAAMgEAAAwAAABwcm9qZWN0Lmpzb257ImZvcm1hdCI6Im9wZW4tbWVkaWEtcHJvamVjdCIsInZlcnNpb24iOjEsInByb2plY3QiOnsidmVyc2lvbiI6MSwiaWQiOiJwb3J0YWJsZS1maXh0dXJlIiwidGl0bGUiOiLml6fpobnnm67lhbzlrrkiLCJ3aWR0aCI6MTkyMCwiaGVpZ2h0IjoxMDgwLCJmcHMiOjMwLCJ0cmFja3MiOltdLCJhc3NldHMiOlt7ImlkIjoiYXNzZXQtb25lIiwibmFtZSI6Im1lZGlhLm1wNCIsImtpbmQiOiJ2aWRlbyIsInNpemUiOjUsInVybCI6IiIsIndpZHRoIjoxOTIwLCJoZWlnaHQiOjEwODAsImR1cmF0aW9uIjoxLCJtaW1lIjoidmlkZW8vbXA0In1dfX1QSwECFAAUAAAAAAAAACFYDKEsagUAAAAFAAAADwAAAAAAAAAAAAAAAAAAAAAAbWVkaWEvYXNzZXQtb25lUEsBAhQAFAAAAAAAAAAhWNytJsoyAQAAMgEAAAwAAAAAAAAAAAAAAAAAMgAAAHByb2plY3QuanNvblBLBQYAAAAAAgACAHcAAACOAQAAAAA=";
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let path = directory.path().join("browser.omedia");
        fs::write(
            &path,
            base64::engine::general_purpose::STANDARD
                .decode(fixture)
                .unwrap(),
        )
        .unwrap();
        let loaded = read_archive(&store, &path).unwrap();
        assert_eq!(loaded["title"], "旧项目兼容");
        assert_eq!(
            fs::read(store.authorized_path(&loaded["assets"][0]).unwrap()).unwrap(),
            b"media"
        );
        discard_imported(&store, &loaded).unwrap();
    }

    #[test]
    fn zip64_end_directory_and_locator_are_validated_without_large_allocation() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let source = project(&store, b"zip64 media");
        let path = directory.path().join("zip64.omedia");
        raw_archive(
            &path,
            &source,
            b"zip64 media",
            true,
            CompressionMethod::Stored,
        );
        let original = fs::read(&path).unwrap();
        let end = original.len() - 22;
        let directory_size = u32_at(&original, end + 12) as u64;
        let directory_offset = u32_at(&original, end + 16) as u64;
        let mut bytes = original[..end].to_vec();
        bytes.extend_from_slice(&0x06064b50_u32.to_le_bytes());
        bytes.extend_from_slice(&44_u64.to_le_bytes());
        bytes.extend_from_slice(&45_u16.to_le_bytes());
        bytes.extend_from_slice(&45_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u64.to_le_bytes());
        bytes.extend_from_slice(&2_u64.to_le_bytes());
        bytes.extend_from_slice(&2_u64.to_le_bytes());
        bytes.extend_from_slice(&directory_size.to_le_bytes());
        bytes.extend_from_slice(&directory_offset.to_le_bytes());
        bytes.extend_from_slice(&0x07064b50_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&(end as u64).to_le_bytes());
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        let new_end = bytes.len();
        bytes.extend_from_slice(&original[end..]);
        bytes[new_end + 8..new_end + 12].fill(0xff);
        bytes[new_end + 12..new_end + 20].fill(0xff);
        fs::write(&path, &bytes).unwrap();
        let loaded = read_archive(&store, &path).unwrap();
        discard_imported(&store, &loaded).unwrap();
        // Refuse a forged huge directory count before the ZIP library allocates entries.
        bytes[end + 24..end + 32].copy_from_slice(&u64::MAX.to_le_bytes());
        bytes[end + 32..end + 40].copy_from_slice(&u64::MAX.to_le_bytes());
        fs::write(&path, &bytes).unwrap();
        assert!(read_archive(&store, &path).is_err());
        assert_eq!(staging_count(&store), 0);
    }

    #[test]
    fn crc_failure_cleans_entire_staging_directory_and_preserves_other_media() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let source = project(&store, b"media checksum");
        let path = directory.path().join("corrupt.omedia");
        raw_archive(
            &path,
            &source,
            b"media checksum",
            false,
            CompressionMethod::Stored,
        );
        let mut file = File::options().read(true).write(true).open(&path).unwrap();
        let entry = inspect_archive(&mut file)
            .unwrap()
            .into_iter()
            .find(|entry| entry.name.starts_with("media/"))
            .unwrap();
        file.seek(SeekFrom::Start(entry.data)).unwrap();
        file.write_all(b"X").unwrap();
        drop(file);
        let error = read_archive(&store, &path).unwrap_err();
        assert!(error.contains("校验"), "{error}");
        assert_eq!(staging_count(&store), 0);
        assert_eq!(
            fs::read(store.root.join("source.mp4")).unwrap(),
            b"media checksum"
        );
    }

    #[test]
    fn missing_extra_mismatched_and_unbounded_manifest_assets_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let source = project(&store, b"media");
        let path = directory.path().join("invalid.omedia");
        for invalid in [
            {
                let mut value = source.clone();
                value["assets"][0]["size"] = 6.into();
                value
            },
            {
                let mut value = source.clone();
                value["assets"][0]["id"] = "missing".into();
                value
            },
            {
                let mut value = source.clone();
                value["assets"] = json!([]);
                value
            },
            {
                let mut value = source.clone();
                value["assets"] = json!([value["assets"][0], value["assets"][0]]);
                value
            },
        ] {
            raw_archive(&path, &invalid, b"media", false, CompressionMethod::Stored);
            assert!(read_archive(&store, &path).is_err());
            assert_eq!(staging_count(&store), 0);
        }
        let mut oversized = source.clone();
        oversized["title"] = "x".repeat(MAX_MANIFEST as usize + 1).into();
        assert!(write_archive(&mut File::create(&path).unwrap(), &store, &oversized).is_err());
    }

    #[test]
    fn raw_directory_rejects_duplicate_traversal_links_encryption_and_overlap() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let source = project(&store, b"media");
        let path = directory.path().join("mutated.omedia");
        raw_archive(&path, &source, b"media", false, CompressionMethod::Stored);
        let valid = fs::read(&path).unwrap();
        let eocd = valid.len() - 22;
        let central = u32_at(&valid, eocd + 16) as usize;
        let second = central
            + 46
            + u16_at(&valid, central + 28) as usize
            + u16_at(&valid, central + 30) as usize;
        let local_second = u32_at(&valid, second + 42) as usize;
        let mutations: Vec<Box<dyn Fn(&mut Vec<u8>)>> = vec![
            Box::new(move |bytes| {
                bytes[second + 8] |= 1;
                bytes[local_second + 6] |= 1;
            }),
            Box::new(move |bytes| {
                bytes[second + 38..second + 42]
                    .copy_from_slice(&(0o120777_u32 << 16).to_le_bytes());
            }),
            Box::new(move |bytes| {
                bytes[second + 46..second + 46 + 15].copy_from_slice(b"media/../escape");
                bytes[local_second + 30..local_second + 45].copy_from_slice(b"media/../escape");
            }),
            Box::new(move |bytes| {
                bytes[second + 42..second + 46].copy_from_slice(&0_u32.to_le_bytes());
            }),
            Box::new(move |bytes| {
                bytes[eocd + 8..eocd + 10].copy_from_slice(&1002_u16.to_le_bytes());
                bytes[eocd + 10..eocd + 12].copy_from_slice(&1002_u16.to_le_bytes());
            }),
        ];
        for mutate in mutations {
            let mut bytes = valid.clone();
            mutate(&mut bytes);
            fs::write(&path, bytes).unwrap();
            assert!(read_archive(&store, &path).is_err());
            assert_eq!(staging_count(&store), 0);
        }
        // Duplicate a central record without asking the ZIP library to create an invalid entry.
        let mut duplicate = valid[..eocd].to_vec();
        duplicate.extend_from_slice(&valid[second..eocd]);
        let new_end = duplicate.len();
        duplicate.extend_from_slice(&valid[eocd..]);
        duplicate[new_end + 8..new_end + 10].copy_from_slice(&3_u16.to_le_bytes());
        duplicate[new_end + 10..new_end + 12].copy_from_slice(&3_u16.to_le_bytes());
        duplicate[new_end + 12..new_end + 16]
            .copy_from_slice(&((new_end - central) as u32).to_le_bytes());
        fs::write(&path, duplicate).unwrap();
        assert!(read_archive(&store, &path).unwrap_err().contains("重复"));
    }

    #[test]
    fn external_native_path_cannot_be_archived_and_failed_save_preserves_target() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let mut source = project(&store, b"inside");
        let outside = directory.path().join("outside.mp4");
        fs::write(&outside, b"private").unwrap();
        source["assets"][0]["nativePath"] = outside.to_string_lossy().into_owned().into();
        let path = directory.path().join("safe.omedia");
        fs::write(&path, b"existing project").unwrap();
        let registry = ProjectFiles::default();
        assert!(registry
            .save_selected_with_writer(path.clone(), true, |file| write_archive(
                file, &store, &source
            ))
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"existing project");
    }

    #[test]
    fn real_300_mib_original_streams_through_save_open_and_save_again() {
        let _serial = LARGE_FILES.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let mut source = project(&store, b"stream marker");
        let source_path = PathBuf::from(source["assets"][0]["nativePath"].as_str().unwrap());
        let mut media = File::options().write(true).open(&source_path).unwrap();
        let size = 300 * 1024 * 1024;
        media.set_len(size).unwrap();
        media.seek(SeekFrom::End(-12)).unwrap();
        media.write_all(b"final marker").unwrap();
        drop(media);
        // A stale asset size must not silently truncate the archive.
        source["assets"][0]["size"] = 1.into();
        let path = directory.path().join("large.omedia");
        let registry = ProjectFiles::default();
        let target = registry
            .save_selected_with_writer(path.clone(), true, |file| {
                write_archive(file, &store, &source)
            })
            .unwrap();
        assert!(fs::metadata(&path).unwrap().len() > size);
        fs::remove_file(source_path).unwrap();
        let loaded = read_archive(&store, &path).unwrap();
        assert_eq!(loaded["assets"][0]["size"].as_u64(), Some(size));
        let loaded_path = store.authorized_path(&loaded["assets"][0]).unwrap();
        let mut media = File::open(&loaded_path).unwrap();
        let mut marker = [0; 12];
        media.seek(SeekFrom::End(-12)).unwrap();
        media.read_exact(&mut marker).unwrap();
        assert_eq!(&marker, b"final marker");
        drop(media);
        assert_eq!(registry.register_opened(path.clone()).unwrap(), target);
        let same = registry
            .save_registered_with_writer(&target.token, |file| write_archive(file, &store, &loaded))
            .unwrap();
        assert_eq!(same, target);
        discard_imported(&store, &loaded).unwrap();
        assert_eq!(staging_count(&store), 0);
    }

    #[test]
    fn archive_over_one_gib_streams_without_legacy_ipc_limit() {
        let _serial = LARGE_FILES.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let store = MediaStore::new(directory.path()).unwrap();
        let source = project(&store, b"large source");
        let source_path = Path::new(source["assets"][0]["nativePath"].as_str().unwrap());
        let size = 1024 * 1024 * 1024 + 73;
        File::options()
            .write(true)
            .open(source_path)
            .unwrap()
            .set_len(size)
            .unwrap();
        let path = directory.path().join("over-one-gib.omedia");
        let registry = ProjectFiles::default();
        registry
            .save_selected_with_writer(path.clone(), false, |file| {
                write_archive(file, &store, &source)
            })
            .unwrap();
        assert!(fs::metadata(&path).unwrap().len() > size);
        assert_eq!(
            inspect_archive(&mut File::open(&path).unwrap()).unwrap()[1].size,
            size
        );
        let mut archive = ZipArchive::new(File::open(&path).unwrap()).unwrap();
        copy_exact(
            &mut archive.by_name("media/asset-one").unwrap(),
            &mut io::sink(),
            size,
        )
        .unwrap();
        drop(archive);
        assert!(registry.register_opened(path).is_ok());
    }
}
