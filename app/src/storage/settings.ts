const SETTINGS_KEY = "acp:settings";

export type ACPSettings = {
  debugEnabled: boolean;
  killSwitchEnabled: boolean;
};

export const loadSettings = (): ACPSettings => {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) {
    return { debugEnabled: false, killSwitchEnabled: false };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ACPSettings>;
    return {
      debugEnabled: parsed.debugEnabled ?? false,
      killSwitchEnabled: parsed.killSwitchEnabled ?? false,
    };
  } catch {
    return { debugEnabled: false, killSwitchEnabled: false };
  }
};

export const saveSettings = (settings: ACPSettings) => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
};
