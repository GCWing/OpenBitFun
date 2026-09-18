use super::types::LOOPX_BUILTIN_APP_ID;

/// Private runtime extension for the verified built-in LoopX product surface.
/// Ordinary and marketplace MiniApps never receive this source.
pub(crate) fn private_bridge_extension(app_id: &str) -> Option<&'static str> {
    (app_id == LOOPX_BUILTIN_APP_ID).then_some(
        r#"// Private product extension for the verified built-in LoopX surface.
    // The outer bridge and Desktop host independently verify active scope,
    // bundled source identity, customization origin, and execution domain.
    loopx: {
      attach:        (opts) => _rpc('loopx.attach', opts || {}),
      listModels:    () => _rpc('loopx.listModels', {}),
      resolveIntake: (opts) => _rpc('loopx.resolveIntake', opts || {}),
      createTask:    (opts) => _rpc('loopx.createTask', opts || {}),
      action:        (opts) => _rpc('loopx.action', opts || {}),
      eventsSince:   (opts) => _rpc('loopx.eventsSince', opts || {}),
      turnOutputSince: (opts) => _rpc('loopx.turnOutputSince', opts || {}),
      onEvent:       (fn) => app.on('loopx:event', fn),
      offEvent:      (fn) => app.off('loopx:event', fn),
    },"#,
    )
}
