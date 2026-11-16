// Languages offered in the session picker. "auto" mirrors whatever language
// the user speaks (the backend then sends no language_code pin and instructs
// the model to follow the user); anything else pins the voice to that locale.

export const AUTO_LANGUAGE = "auto";

export interface LanguageOption {
  code: string;
  label: string;
}

export const LANGUAGES: LanguageOption[] = [
  { code: AUTO_LANGUAGE, label: "Auto — mirror my language" },
  { code: "en-US", label: "English (US)" },
  { code: "en-IN", label: "English (India)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "hi-IN", label: "हिन्दी Hindi" },
  { code: "ta-IN", label: "தமிழ் Tamil" },
  { code: "te-IN", label: "తెలుగు Telugu" },
  { code: "kn-IN", label: "ಕನ್ನಡ Kannada" },
  { code: "ml-IN", label: "മലയാളം Malayalam" },
  { code: "bn-IN", label: "বাংলা Bengali" },
  { code: "mr-IN", label: "मराठी Marathi" },
  { code: "gu-IN", label: "ગુજરાતી Gujarati" },
  { code: "pa-IN", label: "ਪੰਜਾਬੀ Punjabi" },
  { code: "ur-IN", label: "اردو Urdu" },
  { code: "es-ES", label: "Español Spanish" },
  { code: "fr-FR", label: "Français French" },
  { code: "de-DE", label: "Deutsch German" },
  { code: "pt-BR", label: "Português Portuguese" },
  { code: "it-IT", label: "Italiano Italian" },
  { code: "ru-RU", label: "Русский Russian" },
  { code: "ar-EG", label: "العربية Arabic" },
  { code: "zh-CN", label: "中文 Mandarin" },
  { code: "ja-JP", label: "日本語 Japanese" },
  { code: "ko-KR", label: "한국어 Korean" },
  { code: "id-ID", label: "Bahasa Indonesia" },
  { code: "th-TH", label: "ไทย Thai" },
  { code: "vi-VN", label: "Tiếng Việt Vietnamese" },
  { code: "tr-TR", label: "Türkçe Turkish" },
];

export function isKnownLanguage(code: string): boolean {
  return LANGUAGES.some((l) => l.code === code);
}

/** localStorage key for the picker's last choice. */
export const LANGUAGE_STORAGE_KEY = "voiceagent.language";

export function savedLanguage(): string {
  try {
    const value = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return value && isKnownLanguage(value) ? value : AUTO_LANGUAGE;
  } catch {
    return AUTO_LANGUAGE;
  }
}

export function rememberLanguage(code: string) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
  } catch {
    // Private mode / storage disabled: the picker still works for this session.
  }
}
