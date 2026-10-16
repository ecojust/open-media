use open_media_lib::{
    engine::{MediaStore, Runtime},
    preview,
};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    path::Path,
};

fn main() {
    let root = tempfile::tempdir().expect("create driver workspace");
    let store = MediaStore::new(root.path()).expect("create driver media library");
    let runtime = Runtime::discover(None, None).expect("media runtime is required");
    for line in io::stdin().lock().lines().map_while(Result::ok) {
        let request: Value = serde_json::from_str(&line).expect("valid driver request");
        let id = request["id"].clone();
        let result = match request["command"].as_str() {
            Some("import") => store
                .import(&runtime, Path::new(request["path"].as_str().unwrap()), None)
                .and_then(|asset| serde_json::to_value(asset).map_err(|error| error.to_string())),
            Some("preview") => preview::create_preview(&store, &runtime, &request["asset"])
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
            Some("quit") => break,
            _ => Err("unknown driver command".into()),
        };
        let response = match result {
            Ok(value) => json!({"id":id,"result":value}),
            Err(error) => json!({"id":id,"error":error}),
        };
        println!("{response}");
        io::stdout().flush().unwrap();
    }
}
