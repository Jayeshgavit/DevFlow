//! Model-facing read operations only. No mutation or process APIs.
use super::*;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};

pub const MAX_CALLS: usize = 16;
pub const TOTAL_BYTES: usize = 64 * 1024;
const RESULT_BYTES: usize = 12 * 1024;
const FILE_BYTES: u64 = 256 * 1024;
const SCAN_ENTRIES: usize = 10_000;
const SCAN_BYTES: usize = 8 * 1024 * 1024;

pub struct Context {
    pub token: String, pub window: String, pub project: String, pub root: String,
    pub lease: u64, pub cancelled: AtomicBool,
}
#[derive(Default)]
pub struct ResearchState(pub Mutex<HashMap<String, Arc<Context>>>);
impl ResearchState {
    pub fn clear(&self, window: &str, token: Option<&str>) {
        if let Ok(mut map) = self.0.lock() {
            if map.get(window).is_some_and(|c| token.is_none_or(|t| t == c.token)) {
                if let Some(c) = map.remove(window) { c.cancelled.store(true, Ordering::SeqCst); }
            }
        }
    }
    pub fn get(&self, window: &str, token: &str) -> Result<Arc<Context>, String> {
        self.0.lock().map_err(|_| "Research context unavailable.")?.get(window)
            .filter(|c| c.token == token && !c.cancelled.load(Ordering::SeqCst)).cloned()
            .ok_or_else(|| "Research context expired. Select the project again.".into())
    }
}
impl Context {
    pub fn validate(&self, app: &tauri::AppHandle) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) || app.get_webview_window(&self.window).is_none() { return Err("Research cancelled: project or window changed.".into()); }
        app.state::<crate::editor_window::EditorWindow>().0.lock().map_err(|_| "Editor session unavailable.")?
            .check_writer(&self.window, self.lease).map_err(|_| "Research cancelled: editor session changed.")?;
        resolve(app, &self.project, &self.root, "", true).map(|_| ()).map_err(|_| "Research cancelled: saved project root changed.".into())
    }
}
#[tauri::command]
pub fn ai_research_context(app: tauri::AppHandle, window: tauri::WebviewWindow, project_id: String, expected_root: String, lease: u64) -> Result<String, String> {
    let c = Arc::new(Context { token: crate::project_storage::new_id("research-")?, window: window.label().into(), project: project_id, root: expected_root, lease, cancelled: AtomicBool::new(false) });
    c.validate(&app)?;
    let state = app.state::<ResearchState>();
    let mut map = state.0.lock().map_err(|_| "Research context unavailable.")?;
    if let Some(old) = map.insert(c.window.clone(), c.clone()) { old.cancelled.store(true, Ordering::SeqCst); }
    Ok(c.token.clone())
}
#[tauri::command]
pub fn ai_clear_research_context(state: tauri::State<'_, ResearchState>, window: tauri::WebviewWindow, token: String) {
    state.clear(window.label(), Some(&token));
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListArgs { #[serde(default)] path: String, #[serde(default)] offset: usize }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArgs { query: String, #[serde(default)] path: String, #[serde(default)] filename: String, #[serde(default)] case_insensitive: bool, #[serde(default)] cursor: Option<String> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadArgs { path: String, #[serde(default = "one")] start_line: usize, #[serde(default = "end")] end_line: usize }
fn one() -> usize { 1 } fn end() -> usize { 120 }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GuidanceArgs { #[serde(default)] path: String, #[serde(default)] cursor: Option<String> }
fn parse<T: DeserializeOwned>(args: &str) -> Result<T, String> {
    if args.len() > 4096 { return Err("Tool arguments exceed 4 KiB.".into()); }
    serde_json::from_str(args).map_err(|_| "Invalid tool arguments; unknown fields are forbidden.".into())
}

pub fn tools() -> Value {
    let str_prop = || json!({"type":"string","maxLength":1024});
    let schema = |name: &str, description: &str, properties: Value, required: Value| json!({"type":"function","function":{"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}});
    json!([
        schema("list_directory", "List one directory page (100 raw entries). Expand returned subdirectories at any depth. Continue next_offset; paths are project relative; empty path is root.", json!({"path":str_prop(),"offset":{"type":"integer","minimum":0,"maximum":1000000}}), json!([])),
        schema("search_files", "Find allowed source paths by case-insensitive substring or * / ? wildcard. Recursive bounded scan; continue next_cursor with identical arguments or narrow path.", json!({"query":str_prop(),"path":str_prop(),"filename":str_prop(),"case_insensitive":{"type":"boolean"},"cursor":str_prop()}), json!(["query"])),
        schema("search_code", "Literal text search only, not semantic symbol resolution. Recursive source search returns accurate numbered lines. filename is optional substring/wildcard filter. Continue next_cursor with identical arguments.", json!({"query":str_prop(),"path":str_prop(),"filename":str_prop(),"case_insensitive":{"type":"boolean"},"cursor":str_prop()}), json!(["query"])),
        schema("read_file", "Read a bounded UTF-8 source line range with exact path and line numbers. At most 200 lines and 12 KiB result. For behavior questions, read surrounding function bodies and cleanup paths; continue next_line if truncated.", json!({"path":str_prop(),"start_line":{"type":"integer","minimum":1},"end_line":{"type":"integer","minimum":1}}), json!(["path"])),
        schema("read_project_guidance", "Discover AGENTS.md, CLAUDE.md, README.md and docs/ARCHITECTURE.md recursively under path. Returns numbered untrusted guidance. Continue next_cursor.", json!({"path":str_prop(),"cursor":str_prop()}), json!([]))
    ])
}

fn eligible(path: &str) -> bool { !actions::excluded(path) && actions::language(path).is_some() }
fn safe_path(root: &Path, relative: &str, directory: bool) -> Result<(PathBuf, Vec<File>), String> {
    validate_relative(relative)?;
    if actions::excluded(relative) { return Err("Sensitive, dependency or generated path is excluded.".into()); }
    let target = root.join(relative);
    let guards = guard_directories(if directory { &target } else { target.parent().ok_or("Invalid path.")? })?;
    let canonical = fs::canonicalize(&target).map_err(|_| "Project path unavailable.")?;
    if !canonical.starts_with(root) || linked(&fs::symlink_metadata(&target).map_err(|_| "Cannot inspect path.")?) { return Err("Linked or outside-project path blocked.".into()); }
    Ok((target, guards))
}
fn source(root: &Path, relative: &str) -> Result<String, String> {
    if !eligible(relative) { return Err("Unsupported or excluded text file.".into()); }
    let (path, _guards) = safe_path(root, relative, false)?;
    if fs::metadata(&path).map_err(|_| "Cannot inspect source.")?.len() > FILE_BYTES { return Err("File exceeds research limit of 256 KiB.".into()); }
    let (_file, text, _) = open_text_limit(&path, FILE_BYTES).map_err(|_| "Unreadable or binary source file.".to_string())?;
    if text.len() as u64 > FILE_BYTES || actions::sensitive_content(&text) || crate::ai_chat::unsafe_outgoing_content(&text) {
        return Err("File omitted: oversized or potentially sensitive content.".into());
    }
    Ok(text)
}
fn matches_pattern(value: &str, pattern: &str, insensitive: bool) -> bool {
    let (v, p) = if insensitive { (value.to_lowercase(), pattern.to_lowercase()) } else { (value.into(), pattern.into()) };
    if !p.contains(['*','?']) { return v.contains(&p); }
    let (v,p) = (v.chars().collect::<Vec<_>>(),p.chars().collect::<Vec<_>>());
    let (mut i,mut j,mut star,mut mark) = (0,0,None,0);
    while i<v.len() {
        if j<p.len() && (p[j]=='?' || p[j]==v[i]) { i+=1; j+=1; }
        else if j<p.len() && p[j]=='*' { star=Some(j); j+=1; mark=i; }
        else if let Some(s)=star { mark+=1; i=mark; j=s+1; } else { return false; }
    }
    while j<p.len() && p[j]=='*' { j+=1; } j==p.len()
}
struct Walk { key: String, stack: Vec<(fs::ReadDir, Vec<File>)>, pending: Option<(String, usize)> }
impl Walk {
    fn new(root: &Path, path: &str, key: String) -> Result<Self, String> {
        let (target, guards)=safe_path(root,path,true)?;
        Ok(Self { key, stack: vec![(fs::read_dir(target).map_err(|_| "Cannot list folder.")?,guards)], pending: None })
    }
    fn next(&mut self, root: &Path) -> Result<Option<(String,bool,u64)>, String> {
        loop {
            let Some((iter,_))=self.stack.last_mut() else { return Ok(None); };
            let Some(entry)=iter.next() else { self.stack.pop(); continue; };
            let entry=entry.map_err(|_| "Cannot read directory entry.")?;
            let path=entry.path();
            let relative=path.strip_prefix(root).map_err(|_| "Outside project.")?.to_str().ok_or("Non UTF-8 path.")?.replace('\\',"/");
            if validate_relative(&relative).is_err() || actions::excluded(&relative) { return Ok(Some((String::new(),false,0))); }
            let metadata=fs::symlink_metadata(&path).map_err(|_| "Cannot inspect entry.")?;
            if linked(&metadata) { return Ok(Some((String::new(),false,0))); }
            if metadata.is_dir() {
                if self.stack.len() >= 256 { return Err("Practical path depth limit (256) reached; narrow the search path.".into()); }
                let (target,mut guards)=safe_path(root,&relative,true)?;
                // Ancestors remain locked by their stack frames; retain only this child.
                let child_guard=guards.pop().into_iter().collect();
                self.stack.push((fs::read_dir(target).map_err(|_| "Cannot list folder.")?,child_guard));
            }
            return Ok(Some((relative,metadata.is_dir(),metadata.len())));
        }
    }
}
pub struct Research {
    calls: usize, bytes: usize, seen: HashSet<String>, cursors: HashMap<String, Walk>, start: Instant, root: Option<PathBuf>,
}
impl Default for Research { fn default() -> Self { Self { calls:0,bytes:0,seen:HashSet::new(),cursors:HashMap::new(),start:Instant::now(),root:None } } }
impl Research {
    pub fn execute(&mut self, root: &Path, cancelled: &AtomicBool, name: &str, args: &str) -> Result<Value,String> {
        self.check(cancelled)?;
        if self.root.as_deref().is_some_and(|bound| bound != root) { return Err("Research is bound to another project root.".into()); }
        self.root.get_or_insert_with(|| root.to_owned());
        if self.calls >= MAX_CALLS || self.bytes >= TOTAL_BYTES { return Err("Research tool-call or total context limit reached; ask a narrower follow-up.".into()); }
        self.calls+=1;
        let key=format!("{name}:{}",serde_json::from_str::<Value>(args).map_err(|_| "Invalid tool JSON.")?);
        if !self.seen.insert(key) { return Err("Duplicate tool request; reuse the previous evidence or continue its page.".into()); }
        let mut value=match name {
            "list_directory" => self.list(root,parse(args)?,cancelled)?,
            "read_file" => self.read(root,parse(args)?)?,
            "search_files"|"search_code" => self.search(root,name,parse(args)?,cancelled)?,
            "read_project_guidance" => { let a:GuidanceArgs=parse(args)?; self.search(root,name,SearchArgs{query:String::new(),path:a.path,filename:String::new(),case_insensitive:false,cursor:a.cursor},cancelled)? },
            _ => return Err("Unrecognized tool: only the five read-only research tools are permitted.".into()),
        };
        value["untrusted_source_data"]=json!(true);
        let size=serde_json::to_vec(&value).map_err(|_| "Cannot encode tool result.")?.len();
        if size>RESULT_BYTES || self.bytes+size>TOTAL_BYTES { return Err("Research output/context byte limit reached. Narrow the request.".into()); }
        self.bytes+=size;
        self.check(cancelled)?;
        Ok(value)
    }
    fn check(&self,cancelled:&AtomicBool)->Result<(),String> {
        if cancelled.load(Ordering::SeqCst) { Err("Research cancelled.".into()) }
        else if self.start.elapsed()>Duration::from_secs(180) { Err("Research turn timed out (180 seconds).".into()) } else { Ok(()) }
    }
    fn list(&self,root:&Path,a:ListArgs,cancelled:&AtomicBool)->Result<Value,String> {
        if a.offset>1_000_000 { return Err("Directory pagination limit reached; choose a subfolder.".into()); }
        let (path,_guards)=safe_path(root,&a.path,true)?;
        let mut entries=Vec::new(); let mut more=false; let mut skipped=0;
        let start=Instant::now(); let mut output=0;
        for (i,entry) in fs::read_dir(path).map_err(|_| "Cannot list folder.")?.enumerate() {
            self.check(cancelled)?;
            if start.elapsed()>Duration::from_secs(3) { return Err("Directory page timed out; choose a smaller subfolder.".into()); }
            if i<a.offset { continue; }
            if i>=a.offset+100 || output>8000 { more=true; break; }
            let entry=entry.map_err(|_| "Cannot read entry.")?;
            let rel=entry.path().strip_prefix(root).map_err(|_| "Outside project.")?.to_str().ok_or("Non UTF-8 path.")?.replace('\\',"/");
            let meta=fs::symlink_metadata(entry.path()).map_err(|_| "Cannot inspect entry.")?;
            skipped+=1;
            if validate_relative(&rel).is_err() || actions::excluded(&rel) || linked(&meta) || (!meta.is_dir() && (!meta.is_file() || !eligible(&rel))) { continue; }
            let row=json!({"path":rel,"type":if meta.is_dir(){"directory"}else{"file"},"bytes":if meta.is_file(){Some(meta.len())}else{None}});
            output+=row.to_string().len(); entries.push(row);
        }
        Ok(json!({"path":a.path,"entries":entries,"next_offset":if more{Some(a.offset+skipped)}else{None},"truncated":more,"note":"Excluded files omitted. Pagination order reflects the live filesystem; changing directories can change pages."}))
    }
    fn read(&self,root:&Path,a:ReadArgs)->Result<Value,String> {
        if a.start_line==0 || a.end_line<a.start_line || a.end_line-a.start_line>=200 { return Err("Read range must contain 1–200 lines.".into()); }
        let text=source(root,&a.path)?; let total=text.lines().count();
        let mut lines=Vec::new(); let mut bytes=0; let mut next=a.start_line;
        for (i,line) in text.lines().enumerate().skip(a.start_line-1).take(a.end_line-a.start_line+1) {
            let row=json!({"line":i+1,"text":line}); let size=row.to_string().len();
            if size+bytes>10_000 { break; } bytes+=size; lines.push(row); next=i+2;
        }
        if lines.is_empty() && a.start_line<=total { return Err("Selected line exceeds the result byte limit; use a text search for a short snippet.".into()); }
        Ok(json!({"path":a.path,"lines":lines,"total_lines":total,"truncated":next<=total,"next_line":if next<=total{Some(next)}else{None}}))
    }
    fn search(&mut self,root:&Path,name:&str,a:SearchArgs,cancelled:&AtomicBool)->Result<Value,String> {
        if a.query.len()>256 || a.filename.len()>256 || (name!="read_project_guidance" && a.query.is_empty()) { return Err("Search query must contain 1–256 bytes.".into()); }
        let key=format!("{name}|{}|{}|{}|{}",a.path,a.query,a.filename,a.case_insensitive);
        let mut walk=if let Some(cursor)=a.cursor { let w=self.cursors.remove(&cursor).ok_or("Unknown or expired search cursor.")?; if w.key!=key { return Err("Cursor does not match this search.".into()); } w } else { Walk::new(root,&a.path,key)? };
        let mut rows=Vec::new(); let mut output=0; let mut entries=0; let mut scanned=0; let mut omitted=0; let mut done=false;
        let start=Instant::now();
        while entries<SCAN_ENTRIES && scanned+FILE_BYTES as usize<=SCAN_BYTES && output<7000 && rows.len()<40 && start.elapsed()<Duration::from_secs(3) {
            self.check(cancelled)?; entries+=1;
            let (path,resume)=if let Some(p)=walk.pending.take(){p}else{
                let Some((path,dir,size))=walk.next(root)? else {done=true;break;};
                if path.is_empty() || dir || !eligible(&path) || size>FILE_BYTES { continue; }
                (path,0)
            };
            if !a.filename.is_empty() && !matches_pattern(&path,&a.filename,true) {continue;}
            if name=="search_files" && !matches_pattern(&path,&a.query,true) {continue;}
            if name=="read_project_guidance" && !matches!(path.rsplit('/').next().unwrap_or(""),"AGENTS.md"|"CLAUDE.md"|"README.md") && !path.ends_with("docs/ARCHITECTURE.md") {continue;}
            if name=="search_files" {let row=json!({"path":path});output+=row.to_string().len();rows.push(row);continue;}
            let text=match source(root,&path){Ok(t)=>t,Err(_)=>{omitted+=1;scanned+=FILE_BYTES as usize;continue;}};
            scanned+=text.len();
            for (i,line) in text.lines().enumerate().skip(resume) {
                self.check(cancelled)?;
                let found=name=="read_project_guidance" || if a.case_insensitive {line.to_lowercase().contains(&a.query.to_lowercase())}else{line.contains(&a.query)};
                if !found {continue;}
                if output>=7000 || rows.len()>=40 {walk.pending=Some((path.clone(),i));break;}
                let normalized=if a.case_insensitive {line.to_lowercase()}else{line.into()};
                let needle=if a.case_insensitive {a.query.to_lowercase()}else{a.query.clone()};
                let match_at=if name=="read_project_guidance" {0}else{normalized.find(&needle).map(|byte| normalized[..byte].chars().count()).unwrap_or(0)};
                let snippet:String=line.chars().skip(match_at.saturating_sub(80)).take(240).collect();
                let row=json!({"path":path,"line":i+1,"text":snippet,"line_truncated":line.chars().count()>240});
                output+=row.to_string().len();rows.push(row);
            }
        }
        let cursor=if done{None}else{let token=crate::project_storage::new_id("page-")?;self.cursors.insert(token.clone(),walk);Some(token)};
        Ok(json!({"results":rows,"next_cursor":cursor,"truncated":!done,"omitted_files":omitted,"note":"Text search only. Excluded, binary, oversized and potentially sensitive files are omitted; absence is not proof a symbol does not exist."}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root=std::env::temp_dir().join(crate::project_storage::new_id("devflow-research-test-").unwrap());
            fs::create_dir(&root).unwrap(); Self(fs::canonicalize(root).unwrap())
        }
        fn file(&self,path:&str,text:&str) { let target=self.0.join(path);fs::create_dir_all(target.parent().unwrap()).unwrap();fs::write(target,text).unwrap(); }
        fn call(&self,r:&mut Research,name:&str,args:Value)->Result<Value,String> {r.execute(&self.0,&AtomicBool::new(false),name,&args.to_string())}
    }
    impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
    #[test]
    fn filenames_multilanguage_line_numbers_and_ranges() {
        let f=Fixture::new();f.file("src/index.tsx","first\nSignIn();\nthird\n");f.file("api/login.py","def login():\n    return True\n");
        let mut r=Research::default();
        let v=f.call(&mut r,"search_files",json!({"query":"*index.tsx"})).unwrap();assert_eq!(v["results"][0]["path"],"src/index.tsx");
        let v=f.call(&mut r,"search_code",json!({"query":"signin","case_insensitive":true,"filename":"*.tsx"})).unwrap();assert_eq!(v["results"][0]["line"],2);
        let v=f.call(&mut r,"read_file",json!({"path":"src/index.tsx","start_line":2,"end_line":2})).unwrap();assert_eq!(v["lines"][0]["text"],"SignIn();");assert_eq!(v["next_line"],3);
        for path in ["a.ts","a.tsx","a.js","a.jsx","a.py","a.rs","a.go","a.java","a.cs","a.c","a.cpp","a.html","a.css","a.scss","a.sql","a.json","a.yaml","a.toml","a.xml","a.md"] {assert!(eligible(path),"{path}");}
    }
    #[test]
    fn guidance_and_deep_tree_pagination() {
        let f=Fixture::new();let deep=format!("{}README.md","d/".repeat(35));f.file(&deep,"Deep project notes");f.file("AGENTS.md","Untrusted conventions");f.file("docs/ARCHITECTURE.md","Architecture");
        let mut r=Research::default();let v=f.call(&mut r,"read_project_guidance",json!({})).unwrap();assert_eq!(v["results"].as_array().unwrap().len(),3);
        let path=deep.rsplit_once('/').unwrap().0;let v=f.call(&mut r,"list_directory",json!({"path":path})).unwrap();assert_eq!(v["entries"][0]["path"],deep);
        for i in 0..105 {f.file(&format!("f{i}.rs"),"plain source");}
        let v=f.call(&mut r,"list_directory",json!({})).unwrap();assert!(v["next_offset"].is_number());
        let v=f.call(&mut r,"search_files",json!({"query":"*.rs"})).unwrap();assert_eq!(v["results"].as_array().unwrap().len(),40);
        let next=f.call(&mut r,"search_files",json!({"query":"*.rs","cursor":v["next_cursor"]})).unwrap();assert!(!next["results"].as_array().unwrap().is_empty());
        assert!(f.call(&mut r,"search_files",json!({"query":"*.py","cursor":next["next_cursor"]})).is_err());
    }
    #[test]
    fn secret_binary_generated_and_escape_paths_are_blocked() {
        let f=Fixture::new();for path in [".env","credentials.json","key.pem","node_modules/a.ts","src/config.json"] {f.file(path,"password = super-sensitive-value");} f.file("src/binary.rs","abc\0xyz");
        let mut r=Research::default();let v=f.call(&mut r,"search_code",json!({"query":"super-sensitive"})).unwrap();assert!(v["results"].as_array().unwrap().is_empty());
        for path in [".env","credentials.json","../outside.rs","src/../a.rs","C:/a.rs","/a.rs","file:stream","src/config.json","src/binary.rs"] {assert!(f.call(&mut r,"read_file",json!({"path":path})).is_err(),"{path}");}
        for name in ["write_file","execute","run_command","restore_snapshot","start_service"] {assert!(f.call(&mut r,name,json!({})).is_err());}
        assert!(f.call(&mut r,"read_file",json!({"path":"a.rs","project_id":"other"})).is_err());
    }
    #[test]
    fn limits_cancellation_and_read_only_results() {
        let f=Fixture::new();f.file("source.rs","one\ntwo\n");let before=fs::read(f.0.join("source.rs")).unwrap();let mut r=Research::default();
        assert!(f.call(&mut r,"read_file",json!({"path":"source.rs","end_line":201})).is_err());
        assert!(r.execute(&f.0,&AtomicBool::new(true),"list_directory","{}").unwrap_err().contains("cancelled"));
        r.calls=MAX_CALLS;assert!(f.call(&mut r,"list_directory",json!({})).is_err());r.calls=0;r.bytes=TOTAL_BYTES;assert!(f.call(&mut r,"list_directory",json!({})).is_err());
        r.bytes=0;f.call(&mut r,"read_file",json!({"path":"source.rs"})).unwrap();assert!(f.call(&mut r,"read_file",json!({"path":"source.rs"})).is_err());
        assert_eq!(before,fs::read(f.0.join("source.rs")).unwrap());assert_eq!(fs::read_dir(&f.0).unwrap().count(),1);
        let other=Fixture::new();assert!(r.execute(&other.0,&AtomicBool::new(false),"list_directory","{}").unwrap_err().contains("another project"));
        r.bytes=TOTAL_BYTES-1;assert!(f.call(&mut r,"list_directory",json!({})).unwrap_err().contains("byte limit"));
        r.start=Instant::now()-Duration::from_secs(181);assert!(r.check(&AtomicBool::new(false)).is_err());
    }
    fn context(window:&str,token:&str)->Arc<Context>{Arc::new(Context{token:token.into(),window:window.into(),project:"p".into(),root:"unused".into(),lease:0,cancelled:AtomicBool::new(false)})}
    #[test]
    fn stale_context_and_window_isolation() {
        let state=ResearchState::default();let c=context("main","first");state.0.lock().unwrap().insert("main".into(),c.clone());
        assert!(state.get("quick-editor","first").is_err());assert!(state.get("main","stale").is_err());
        state.clear("main",Some("stale"));assert!(state.get("main","first").is_ok());state.clear("main",Some("first"));assert!(c.cancelled.load(Ordering::SeqCst));assert!(state.get("main","first").is_err());
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "Requires Windows Developer Mode or symlink privilege; disposable fixtures only"]
    fn windows_linked_directory_and_file_are_blocked() {
        let f=Fixture::new();let outside=Fixture::new();outside.file("safe.rs","outside");
        std::os::windows::fs::symlink_dir(&outside.0,f.0.join("linked")).unwrap();
        std::os::windows::fs::symlink_file(outside.0.join("safe.rs"),f.0.join("linked.rs")).unwrap();
        assert!(safe_path(&f.0,"linked",true).is_err());assert!(source(&f.0,"linked.rs").is_err());
        fs::remove_file(f.0.join("linked.rs")).unwrap();fs::remove_dir(f.0.join("linked")).unwrap();
    }
}
