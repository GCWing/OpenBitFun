use super::geometry::Display;
use super::*;

fn desktop() -> Desktop {
    Desktop(vec![Display {
        bounds: Geometry {
            width: 1920,
            height: 1040,
            x: 0,
            y: 0,
        },
        scale: 1.0,
    }])
}

fn good_geometry() -> Geometry {
    Geometry {
        width: 1200,
        height: 800,
        x: 100,
        y: 80,
    }
}

fn normal_snapshot(geometry: Geometry) -> Snapshot {
    Snapshot {
        geometry,
        maximized: false,
        minimized: false,
        fullscreen: false,
        visible: true,
    }
}

fn reported_legacy_document() -> Value {
    json!({"main": {
        "width": 65519, "height": 65526, "x": 0, "y": 0, "prev_x": 0, "prev_y": 0,
        "maximized": false, "visible": true, "decorated": true, "fullscreen": false,
    }})
}

#[test]
fn reported_legacy_dimensions_are_repaired_before_any_native_restore() {
    let plan = restore_plan(&reported_legacy_document(), &desktop());
    assert!(plan.repair);
    assert_eq!(
        plan.geometry,
        Geometry {
            width: 1200,
            height: 800,
            x: 360,
            y: 120
        }
    );
    assert!(!plan.maximized);
    assert!(desktop().valid(plan.geometry));
}

#[test]
fn invalid_legacy_numeric_shapes_fall_back_without_casting_or_overflow() {
    for width in [json!(-17), json!(1.5), json!(u64::MAX), json!("65519")] {
        let mut document = reported_legacy_document();
        document["main"]["width"] = width;
        let plan = restore_plan(&document, &desktop());
        assert!(plan.repair);
        assert!(desktop().valid(plan.geometry));
    }
}

#[test]
fn rejects_invalid_dimensions_and_inaccessible_positions_without_magic_values() {
    for geometry in [
        Geometry {
            width: 65519,
            height: 65526,
            ..good_geometry()
        },
        Geometry {
            width: u32::MAX,
            ..good_geometry()
        },
        Geometry {
            height: u32::MAX,
            ..good_geometry()
        },
        Geometry {
            width: 0,
            ..good_geometry()
        },
        Geometry {
            width: 440,
            height: 680,
            ..good_geometry()
        },
        Geometry {
            x: i32::MAX,
            ..good_geometry()
        },
        Geometry {
            y: -32000,
            ..good_geometry()
        },
    ] {
        assert!(!desktop().valid(geometry), "{geometry:?}");
    }
}

#[test]
fn supports_negative_coordinates_spanning_screens_and_high_dpi() {
    let mut desktop = desktop();
    desktop.0.push(Display {
        bounds: Geometry {
            width: 3840,
            height: 2080,
            x: -3840,
            y: 0,
        },
        scale: 2.0,
    });
    let high_dpi = Geometry {
        width: 2400,
        height: 1600,
        x: -3600,
        y: 80,
    };
    assert!(desktop.valid(high_dpi));
    assert!(desktop.valid(Geometry {
        width: 4800,
        ..high_dpi
    }));
    let mut document = json!({});
    update_document(&mut document, high_dpi, Some((false, false)));
    assert_eq!(restore_plan(&document, &desktop).geometry, high_dpi);
    assert!(!restore_plan(&document, &desktop).repair);
}

#[test]
fn disconnected_display_and_display_gaps_recover_to_primary() {
    let mut desktop = desktop();
    desktop.0.push(Display {
        bounds: Geometry {
            width: 1920,
            height: 1040,
            x: 6000,
            y: 0,
        },
        scale: 1.0,
    });
    assert!(!desktop.valid(Geometry {
        x: 3000,
        ..good_geometry()
    }));
    let mut document = json!({});
    update_document(
        &mut document,
        Geometry {
            x: -1800,
            ..good_geometry()
        },
        None,
    );
    let plan = restore_plan(&document, &desktop);
    assert!(plan.repair);
    assert_eq!(plan.geometry.x, 360);
}

#[test]
fn defaults_fit_small_high_dpi_work_area() {
    let desktop = Desktop(vec![Display {
        bounds: Geometry {
            width: 1024,
            height: 700,
            x: 0,
            y: 40,
        },
        scale: 2.0,
    }]);
    let geometry = desktop.default_geometry(None);
    assert_eq!(geometry.width, 1024);
    assert_eq!(geometry.height, 700);
    assert!(desktop.valid(geometry));
}

#[test]
fn validates_the_actual_previous_position_used_by_maximized_legacy_windows() {
    let mut document = json!({});
    update_document(&mut document, good_geometry(), Some((true, false)));
    document["main"]["prev_x"] = json!(-32000);
    let plan = restore_plan(&document, &desktop());
    assert!(plan.maximized);
    assert!(plan.repair);
    assert!(desktop().valid(plan.geometry));
}

#[test]
fn partial_legacy_shape_keeps_preferences_and_unknown_fields() {
    let mut document = json!({
        "main": {"width": 100, "maximized": true, "fullscreen": true, "future": {"value": 9}},
        "other-window": {"data": "untouched"},
    });
    let plan = restore_plan(&document, &desktop());
    assert!(plan.maximized && plan.fullscreen && plan.repair);
    update_document(&mut document, plan.geometry, None);
    let reloaded: Value = serde_json::from_slice(&serde_json::to_vec(&document).unwrap()).unwrap();
    assert_eq!(reloaded["main"]["future"]["value"], 9);
    assert_eq!(reloaded["other-window"]["data"], "untouched");
    assert!(restore_plan(&reloaded, &desktop()).maximized);
    assert!(!restore_plan(&reloaded, &desktop()).repair);
}

#[test]
fn old_payload_repair_save_restart_preserves_original_and_does_not_reintroduce_bad_dimensions() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(STATE_FILE);
    let original = serde_json::to_vec_pretty(&reported_legacy_document()).unwrap();
    std::fs::write(&path, &original).unwrap();
    let (mut document, bytes) = read_document(&path).unwrap();
    let plan = restore_plan(&document, &desktop());
    update_document(&mut document, plan.geometry, None);
    write_document(&path, &document, bytes.as_deref()).unwrap();
    // Exit while minimized/maximized: invalid native client bounds must not
    // overwrite the validated normal rectangle retained during startup.
    let mut snapshot = normal_snapshot(Geometry {
        width: 65519,
        height: 65526,
        ..good_geometry()
    });
    snapshot.minimized = true;
    snapshot.maximized = true;
    persist_snapshot(&path, snapshot, Some(plan.geometry), &desktop()).unwrap();
    let restarted = restore_plan(&read_document(&path).unwrap().0, &desktop());
    assert_eq!(restarted.geometry, plan.geometry);
    assert!(restarted.maximized);
    assert!(!restarted.repair);
    let backups: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(Result::unwrap)
        .filter(|file| {
            file.file_name()
                .to_string_lossy()
                .starts_with(".window-state.invalid-")
        })
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read(backups[0].path()).unwrap(), original);
}

#[test]
fn invalid_sample_does_not_overwrite_last_good_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(STATE_FILE);
    persist_snapshot(&path, normal_snapshot(good_geometry()), None, &desktop()).unwrap();
    let before = std::fs::read(&path).unwrap();
    let bad = normal_snapshot(Geometry {
        width: 65519,
        height: 65526,
        ..good_geometry()
    });
    assert!(persist_snapshot(&path, bad, Some(good_geometry()), &desktop()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[test]
fn quitting_from_tray_preserves_pre_hide_maximize_and_fullscreen_preferences() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(STATE_FILE);
    let mut document = json!({});
    update_document(&mut document, good_geometry(), Some((true, true)));
    write_document(&path, &document, None).unwrap();
    let mut hidden = normal_snapshot(good_geometry());
    hidden.visible = false;
    persist_snapshot(&path, hidden, Some(good_geometry()), &desktop()).unwrap();
    let plan = restore_plan(&read_document(&path).unwrap().0, &desktop());
    assert!(plan.maximized && plan.fullscreen);
    assert_eq!(plan.geometry, good_geometry());
}

#[test]
fn macos_development_launch_ignores_saved_fullscreen() {
    let mut document = json!({});
    update_document(&mut document, good_geometry(), Some((true, true)));
    let plan = restore_plan(&document, &desktop());

    assert!(!plan.fullscreen_on_launch(true, "com.openbitfun.desktop.dev"));
    assert!(plan.fullscreen_on_launch(true, "com.openbitfun.desktop"));
    assert!(plan.fullscreen_on_launch(false, "com.openbitfun.desktop.dev"));
    assert!(plan.maximized);
    assert_eq!(plan.geometry, good_geometry());
}

#[test]
fn maximized_fullscreen_and_hidden_samples_keep_last_normal_geometry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(STATE_FILE);
    let mut document = json!({});
    update_document(&mut document, good_geometry(), None);
    document["main"]["future"] = json!("keep");
    write_document(&path, &document, None).unwrap();
    for flags in [
        (true, false, true),
        (false, true, true),
        (false, false, false),
    ] {
        let mut sample = normal_snapshot(Geometry {
            width: 65519,
            height: 65526,
            ..good_geometry()
        });
        (sample.maximized, sample.fullscreen, sample.visible) = flags;
        persist_snapshot(&path, sample, Some(good_geometry()), &desktop()).unwrap();
        let document = read_document(&path).unwrap().0;
        assert_eq!(
            Geometry::read(&document["main"], false),
            Some(good_geometry())
        );
        assert_eq!(document["main"]["future"], "keep");
    }
}

#[test]
fn unreadable_shapes_are_never_overwritten_even_on_exit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(STATE_FILE);
    for original in ["{not json", "[]", "{\"main\":null}"] {
        std::fs::write(&path, original).unwrap();
        assert!(
            persist_snapshot(&path, normal_snapshot(good_geometry()), None, &desktop()).is_err()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }
}

#[test]
fn failed_atomic_replacement_leaves_existing_target_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(STATE_FILE);
    std::fs::create_dir(&path).unwrap();
    let marker = path.join("original");
    std::fs::write(&marker, "preserve").unwrap();
    assert!(write_document(&path, &json!({"main": {}}), None).is_err());
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "preserve");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}
