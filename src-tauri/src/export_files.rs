use crate::engine::{MediaJob, Result};
use std::path::{Path, PathBuf};

fn completed_output(state: &str, output: Option<&str>) -> Result<PathBuf> {
    if state != "completed" {
        return Err("导出成功后才能打开文件夹。".into());
    }
    let path = PathBuf::from(output.ok_or("此导出任务没有输出文件。")?);
    if !path.is_absolute() || !path.is_file() {
        return Err("导出文件已移动或删除，无法在文件夹中显示。".into());
    }
    Ok(path)
}

pub fn reveal_job_output(jobs: &[MediaJob], id: &str) -> Result<()> {
    let job = jobs
        .iter()
        .find(|job| job.id == id)
        .ok_or("导出任务不存在。")?;
    let output = completed_output(&job.state, job.output_path.as_deref())?;
    reveal(&output)
}

fn reveal(path: &Path) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        // The file manager can outlive this request; do not wait for its window to close.
        let mut child = std::process::Command::new("explorer.exe")
            .arg("/select,")
            .arg(path)
            .spawn()
            .map_err(|error| format!("无法打开导出文件夹：{error}"))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(target_os = "macos")]
        let result = std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(path)
            .status();
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let result = std::process::Command::new("xdg-open")
            .arg(path.parent().ok_or("导出目录无效。")?)
            .status();
        let status = result.map_err(|error| format!("无法打开导出文件夹：{error}"))?;
        if !status.success() {
            return Err("无法打开导出文件夹，请从保存位置打开。".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_completed_existing_outputs_can_be_revealed() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("导出文件 空格.mp4");
        std::fs::write(&path, b"exported result").unwrap();
        for state in ["running", "failed", "cancelled"] {
            assert!(completed_output(state, path.to_str()).is_err());
        }
        assert_eq!(completed_output("completed", path.to_str()).unwrap(), path);
        assert!(completed_output("completed", None).is_err());
        assert!(completed_output("completed", folder.path().to_str()).is_err());
        assert!(completed_output("completed", Some("relative.mp4")).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(completed_output("completed", path.to_str()).is_err());
    }

    #[test]
    fn unknown_job_cannot_choose_a_file_path() {
        assert!(reveal_job_output(&[], "/tmp/not-a-job").is_err());
    }
}
