import Foundation

@main
struct AccountFailureCopyTests {
    static func main() {
        let expected = [
            "INVALID_CREDENTIALS": "账号或密码错误",
            "AUTHENTICATION": "登录状态无效，请重新输入账号和密码",
            "RATE_LIMITED": "登录请求过多，请稍后重试",
            "RELAY_UNAVAILABLE": "登录服务暂时不可用，请稍后重试。",
            "NETWORK": "暂时无法连接，请检查网络后重试。",
            "TIMEOUT": "连接超时，请检查网络后重试。",
            "MALFORMED_RESPONSE": "Relay 响应异常，请稍后重试或升级应用",
            "SECURE_STORAGE": "无法访问系统安全存储，请稍后重试。",
        ]
        for (reason, key) in expected {
            precondition(AccountFailureCopy.localizationKey(reason: reason, stage: "AUTHENTICATION") == key)
        }
        precondition(
            AccountFailureCopy.localizationKey(reason: "NETWORK", stage: "DEVICE_LIST") ==
                "登录已完成，但设备列表加载失败。请重试。"
        )
        precondition(
            AccountFailureCopy.localizationKey(reason: "UNAUTHORIZED", stage: "AUTHENTICATION") ==
                "登录服务暂时不可用，请稍后重试"
        )
    }
}
