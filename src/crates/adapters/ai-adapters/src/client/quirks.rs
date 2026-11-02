use crate::providers::reasoning::parse_glm_major_minor;

pub(crate) fn should_append_tool_stream(url: &str, model_name: &str) -> bool {
    if url.contains("bigmodel.cn") || url.contains("api.z.ai") {
        return true;
    }

    if !url.contains("aliyuncs.com") {
        return false;
    }

    parse_glm_major_minor(model_name)
        .is_some_and(|(major, minor)| major > 4 || (major == 4 && minor >= 5))
}
