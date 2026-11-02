mod alert;
mod context;
mod cookie;
mod execution;
mod interaction;
mod locator;
mod runtime;
mod shadow;
mod store;
mod visibility;

pub(super) fn head() -> String {
    format!(
        "{runtime}{store}{context}{locator}{shadow}{visibility}{interaction}",
        runtime = runtime::script(),
        store = store::script(),
        context = context::script(),
        locator = locator::script(),
        shadow = shadow::script(),
        visibility = visibility::script(),
        interaction = interaction::script()
    )
}

pub(super) fn tail() -> String {
    format!(
        "{cookie}{alert}{execution}",
        cookie = cookie::script(),
        alert = alert::script(),
        execution = execution::script()
    )
}
