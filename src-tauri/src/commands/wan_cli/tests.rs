use super::runtime::error_message;
use super::video::{generation_args, materialize_images, saved_video, GenerateWanCliVideoRequest};
use serde_json::json;

fn request() -> GenerateWanCliVideoRequest {
    GenerateWanCliVideoRequest {
        client_job_id: Some("job-1".into()), executable: "wan".into(),
        prompt: "a cat; $(touch should-not-exist) & \"hello\"".into(),
        model_version: "wan3.0".into(), duration: 5, aspect_ratio: "16:9".into(),
        video_resolution: Some("720p".into()), image_mode: Some("reference".into()),
        reference_images: None, reference_audio: None,
    }
}

#[test]
fn maps_text_reference_and_frames_without_shell_interpolation() {
    let mut request = request();
    let text = generation_args(&request, &[]).unwrap();
    assert_eq!(text[0], "text2video");
    assert_eq!(text[4], request.prompt);
    let images = vec!["/tmp/a b.png".into(), "/tmp/c.png".into()];
    let reference = generation_args(&request, &images).unwrap();
    assert_eq!(reference[0], "reference2video");
    assert!(reference.windows(2).any(|pair| pair == ["--assets", "/tmp/a b.png,/tmp/c.png"]));
    request.image_mode = Some("first-last".into());
    let frames = generation_args(&request, &images).unwrap();
    assert_eq!(frames[0], "frame2video");
    assert!(frames.contains(&"--last-frame".into()));
    assert!(!frames.contains(&"--ratio".into()));
    assert!(generation_args(&request, &images[..1]).is_err());
}

#[test]
fn rejects_unsupported_inputs_before_submission() {
    let mut request = request();
    assert!(generation_args(&request, &vec!["ref.png".into(); 6]).is_err());
    request.duration = 31;
    assert!(generation_args(&request, &[]).is_err());
    request.duration = 5;
    request.reference_audio = Some(vec!["audio.mp3".into()]);
    assert!(generation_args(&request, &[]).unwrap_err().contains("音频"));
    request.reference_audio = None;
    request.video_resolution = Some("4k".into());
    assert!(generation_args(&request, &[]).is_err());
}

#[test]
fn interprets_nested_membership_rejection_and_redacts_keys() {
    assert!(error_message(&json!({"errorCode": "400", "details": {"response": {"errorCode": "4018"}}})).contains("仅会员"));
    assert!(error_message(&json!({"errorCode": "400", "details": {"response": {"errorCode": ["9007"]}}})).contains("内容安全审核未通过（9007）"));
    assert!(!error_message(&json!({"errorMsg": "invalid wan-sk.fake.secret"})).contains("wan-sk."));
}

#[test]
fn validates_media_and_download_paths() {
    let directory = std::env::temp_dir().join(format!("lentalk-wan-media-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let images = materialize_images(&["data:image/png;base64,aGVsbG8=".into()], &directory).unwrap();
    assert_eq!(std::fs::read(&images[0]).unwrap(), b"hello");
    assert!(materialize_images(&["data:text/html;base64,aGVsbG8=".into()], &directory).is_err());
    assert!(saved_video(&json!({"savedFiles": [{"path": images[0]}]}), &directory).is_err());
    std::fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn resumes_download_without_resubmitting_and_reuses_completed_job() {
    use std::os::unix::fs::PermissionsExt;
    let directory = std::env::temp_dir().join(format!("lentalk-wan-flow-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let cli = directory.join("fake wan");
    std::fs::write(&cli, r#"#!/usr/bin/env python3
import json, pathlib, sys
root = pathlib.Path(__file__).parent
args = sys.argv[1:]
with (root / 'calls.jsonl').open('a') as log:
    log.write(json.dumps(args) + '\n')
if args[:2] == ['auth', 'status']:
    print(json.dumps({'ok': True, 'authenticated': True}))
elif args[0] == 'text2video':
    print(json.dumps({'taskId': 'task-123'}))
elif args[:2] == ['result', 'get']:
    if '--save' in args:
        once = root / 'failed-once'
        if not once.exists():
            once.touch()
            print(json.dumps({'ok': False, 'errorMsg': 'simulated download failure'}))
            sys.exit(1)
        dest = pathlib.Path(args[args.index('--save-dir') + 1]) / 'result.mp4'
        dest.write_bytes(b'test video')
        print(json.dumps({'ok': True, 'savedFiles': [{'path': str(dest)}]}))
    else:
        print(json.dumps({'ok': True, 'taskId': 'task-123', 'statusLabel': 'succeeded'}))
else:
    print(json.dumps({'ok': False, 'errorMsg': 'unexpected command'}))
    sys.exit(1)
"#).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut request = request();
    request.executable = cli.to_string_lossy().into_owned();
    let output = directory.join("videos");
    let first = super::video::generate(&request, &output, |_, _| {}).await;
    assert!(first.unwrap_err().contains("simulated download failure"));
    let second = super::video::generate(&request, &output, |_, _| {}).await.unwrap();
    assert!(std::path::Path::new(&second).is_file());
    assert_eq!(super::video::generate(&request, &output, |_, _| {}).await.unwrap(), second);
    let calls: Vec<Vec<String>> = std::fs::read_to_string(directory.join("calls.jsonl")).unwrap()
        .lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    assert_eq!(calls.iter().filter(|args| args[0] == "text2video").count(), 1);
    let submitted = calls.iter().find(|args| args[0] == "text2video").unwrap();
    assert_eq!(submitted[4], request.prompt);
    std::fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn ambiguous_submission_does_not_create_a_second_task() {
    use std::os::unix::fs::PermissionsExt;
    let directory = std::env::temp_dir().join(format!("lentalk-wan-ambiguous-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let cli = directory.join("wan");
    std::fs::write(&cli, r#"#!/bin/sh
if [ "$1" = auth ]; then
  printf '%s\n' '{"ok":true,"authenticated":true}'
else
  printf '%s\n' 'gateway returned non-JSON'
fi
"#).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut request = request();
    request.executable = cli.to_string_lossy().into_owned();
    let root = directory.join("output");
    assert!(super::video::generate(&request, &root, |_, _| {}).await.unwrap_err().contains("JSON"));
    // Removing the executable proves recovery reads the durable submission
    // marker before attempting any CLI invocation or creating another task.
    std::fs::remove_file(cli).unwrap();
    assert!(super::video::generate(&request, &root, |_, _| {}).await.unwrap_err().contains("提交结果未确认"));
    std::fs::remove_dir_all(directory).unwrap();
}
