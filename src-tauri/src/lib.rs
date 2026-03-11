use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;

// ------------------ Config ------------------
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub direction: String, // "zh->en" | "en->zh"
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: "".to_string(),
            model: "gpt-4o-mini".to_string(),
            direction: "zh->en".to_string(),
        }
    }
}

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    let mut dir = app.path().app_config_dir().unwrap();
    dir.push("fliptrans");
    let _ = fs::create_dir_all(&dir);
    dir.push("config.json");
    dir
}

fn load_config(app: &tauri::AppHandle) -> AppConfig {
    let path = config_path(app);
    if let Ok(data) = fs::read_to_string(path) {
        if let Ok(cfg) = serde_json::from_str::<AppConfig>(&data) {
            return cfg;
        }
    }
    AppConfig::default()
}

fn save_config(app: &tauri::AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = config_path(app);
    let data = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())
}

// ------------------ History ------------------
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HistoryItem {
    pub source: String,
    pub target: String,
    pub ts: i64,
}

fn history_path(app: &tauri::AppHandle) -> PathBuf {
    let mut dir = app.path().app_config_dir().unwrap();
    dir.push("fliptrans");
    let _ = fs::create_dir_all(&dir);
    dir.push("history.json");
    dir
}

fn load_history(app: &tauri::AppHandle) -> Vec<HistoryItem> {
    let path = history_path(app);
    if let Ok(data) = fs::read_to_string(path) {
        if let Ok(list) = serde_json::from_str::<Vec<HistoryItem>>(&data) {
            return list;
        }
    }
    vec![]
}

fn save_history(app: &tauri::AppHandle, list: &Vec<HistoryItem>) -> Result<(), String> {
    let path = history_path(app);
    let data = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())
}

// ------------------ API ------------------
#[derive(Debug, Serialize, Deserialize)]
struct OpenAIMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct OpenAIRequest {
    model: String,
    messages: Vec<OpenAIMessage>,
    temperature: f32,
}

#[derive(Debug, Serialize, Deserialize)]
struct OpenAIChoice {
    message: OpenAIMessage,
}

#[derive(Debug, Serialize, Deserialize)]
struct OpenAIResponse {
    choices: Vec<OpenAIChoice>,
}

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> AppConfig {
    load_config(&app)
}

#[tauri::command]
fn set_config(app: tauri::AppHandle, cfg: AppConfig) -> Result<(), String> {
    save_config(&app, &cfg)
}

#[tauri::command]
fn get_history(app: tauri::AppHandle) -> Vec<HistoryItem> {
    load_history(&app)
}

#[tauri::command]
fn clear_history(app: tauri::AppHandle) -> Result<(), String> {
    save_history(&app, &vec![])
}

#[tauri::command]
fn add_history(app: tauri::AppHandle, item: HistoryItem) -> Result<(), String> {
    let mut list = load_history(&app);
    list.insert(0, item);
    if list.len() > 50 {
        list.truncate(50);
    }
    save_history(&app, &list)
}

#[tauri::command]
async fn translate(app: tauri::AppHandle, text: String) -> Result<String, String> {
    let cfg = load_config(&app);
    if cfg.api_key.trim().is_empty() {
        return Err("API Key 不能为空".to_string());
    }
    let dir = cfg.direction.clone();
    let sys = if dir == "zh->en" {
        "You are a translation engine. Translate Chinese to English. Output only the translation.".to_string()
    } else {
        "你是一个翻译引擎，把英文翻译成中文，只输出译文。".to_string()
    };

    let req = OpenAIRequest {
        model: cfg.model.clone(),
        messages: vec![
            OpenAIMessage {
                role: "system".to_string(),
                content: sys,
            },
            OpenAIMessage {
                role: "user".to_string(),
                content: text,
            },
        ],
        temperature: 0.2,
    };

    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));

    let client = reqwest::Client::new();
    let resp = client
        .post(url)
        .bearer_auth(cfg.api_key)
        .json(&req)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("API 错误: {} {}", status, text));
    }

    let data: OpenAIResponse = resp.json().await.map_err(|e| e.to_string())?;
    let out = data
        .choices
        .get(0)
        .map(|c| c.message.content.clone())
        .unwrap_or_default();
    Ok(out)
}

// ------------------ Clipboard ------------------
#[tauri::command]
fn get_clipboard(app: tauri::AppHandle) -> Result<String, String> {
    app.clipboard().read_text().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_clipboard(app: tauri::AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

// ------------------ Run ------------------
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            get_history,
            clear_history,
            add_history,
            translate,
            get_clipboard,
            set_clipboard
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
