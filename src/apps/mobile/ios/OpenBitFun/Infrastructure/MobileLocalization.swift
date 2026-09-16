import Foundation

enum MobileLanguage: String, CaseIterable, Identifiable {
    case simplifiedChinese = "zh-Hans"
    case english = "en"

    var id: String { rawValue }

    var nativeName: String {
        switch self {
        case .simplifiedChinese: return "简体中文"
        case .english: return "English"
        }
    }
}

enum MobileLocalization {
    static let preferenceKey = "openbitfun.mobile.language"

    static func restoredLanguage() -> MobileLanguage {
        if let saved = UserDefaults.standard.string(forKey: preferenceKey),
           let language = MobileLanguage(rawValue: saved) {
            return language
        }
        return Locale.preferredLanguages.first?.hasPrefix("zh") == true ? .simplifiedChinese : .english
    }

    static func text(_ key: String, language: MobileLanguage) -> String {
        // Resolve only the selected language bundle. Returning every source key
        // unchanged loses translated English keys added by remote features.
        // An explicit bundle plus key fallback also avoids English fallback for
        // untranslated Chinese source strings.
        guard let path = Bundle.main.path(forResource: language.rawValue, ofType: "lproj"),
              let bundle = Bundle(path: path) else { return key }
        return bundle.localizedString(forKey: key, value: key, table: nil)
    }

    static func text(_ key: String) -> String {
        text(key, language: restoredLanguage())
    }

    static func format(_ key: String, language: MobileLanguage, _ arguments: CVarArg...) -> String {
        String(
            format: text(key, language: language),
            locale: Locale(identifier: language.rawValue),
            arguments: arguments
        )
    }
}
