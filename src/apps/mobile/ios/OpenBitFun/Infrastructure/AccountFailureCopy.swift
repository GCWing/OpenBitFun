import Foundation

enum AccountFailureCopy {
    static func localizationKey(reason: String, stage: String?) -> String {
        if stage == "DEVICE_LIST" {
            return "登录已完成，但设备列表加载失败。请重试。"
        }
        switch reason {
        case "INVALID_CREDENTIALS":
            return "账号或密码错误"
        case "AUTHENTICATION":
            return "登录状态无效，请重新输入账号和密码"
        case "RATE_LIMITED":
            return "登录请求过多，请稍后重试"
        case "RELAY_UNAVAILABLE":
            return "登录服务暂时不可用，请稍后重试。"
        case "NETWORK":
            return "暂时无法连接，请检查网络后重试。"
        case "TIMEOUT":
            return "连接超时，请检查网络后重试。"
        case "MALFORMED_RESPONSE":
            return "Relay 响应异常，请稍后重试或升级应用"
        case "SECURE_STORAGE":
            return "无法访问系统安全存储，请稍后重试。"
        default:
            return "登录服务暂时不可用，请稍后重试"
        }
    }
}
