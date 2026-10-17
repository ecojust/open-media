// SPDX-License-Identifier: MIT
// Small test driver for exercising the exact native text frontend in CI.
#[path = "../src-tauri/src/speech_chinese.rs"]
mod speech_chinese;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 3 {
        return Err("Expected input and output UTF-8 text files".into());
    }
    let input = std::fs::read_to_string(&args[1])?;
    std::fs::write(&args[2], speech_chinese::normalize_chinese(&input))?;
    Ok(())
}
