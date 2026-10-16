import type { VoiceCategoryId } from './voice-catalog'

export interface VoiceGroup {
  category: VoiceCategoryId
  locale: string
  representative: string
  members: readonly string[]
}

// Representative choices from measured weights and same-text audio, not speaker identity.
// Source, grouping bounds and limitations: docs/VOICE_GROUPS.md.
export const VOICE_GROUP_SOURCE = {
  "voiceWeightsSha256": "e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c",
  "chineseSample": "你好，欢迎听这段声音。阳光洒在安静的窗边。",
  "englishSample": "Welcome. The morning sunlight falls gently through the window.",
  "speed": 1,
  "sampleRate": 24000,
  "silenceScale": 0.2,
  "minimumWeightCosine": 0.7,
  "maximumAcousticDistance": 1.4
} as const

export const VOICE_GROUPS: readonly VoiceGroup[] = [
  {"category": "zh-male", "locale": "zh-cn", "representative": "zm_013", "members": ["zm_010", "zm_011", "zm_012", "zm_013", "zm_034", "zm_097"]},
  {"category": "zh-male", "locale": "zh-cn", "representative": "zm_014", "members": ["zm_009", "zm_014", "zm_015", "zm_016", "zm_030", "zm_035", "zm_064"]},
  {"category": "zh-male", "locale": "zh-cn", "representative": "zm_020", "members": ["zm_020", "zm_041"]},
  {"category": "zh-male", "locale": "zh-cn", "representative": "zm_029", "members": ["zm_029"]},
  {"category": "zh-male", "locale": "zh-cn", "representative": "zm_031", "members": ["zm_031", "zm_037"]},
  {"category": "zh-male", "locale": "zh-cn", "representative": "zm_033", "members": ["zm_033"]},
  {"category": "zh-male", "locale": "zh-cn", "representative": "zm_045", "members": ["zm_045", "zm_050", "zm_056", "zm_058", "zm_061", "zm_069", "zm_080", "zm_096"]},
  {"category": "zh-male", "locale": "zh-cn", "representative": "zm_052", "members": ["zm_052", "zm_100"]},
  {"category": "zh-male", "locale": "zh-cn", "representative": "zm_057", "members": ["zm_053", "zm_054", "zm_055", "zm_057", "zm_062", "zm_065", "zm_082", "zm_095", "zm_098"]},
  {"category": "zh-male", "locale": "zh-cn", "representative": "zm_066", "members": ["zm_025", "zm_063", "zm_066", "zm_068", "zm_081", "zm_089", "zm_091"]},
  {"category": "zh-female", "locale": "zh-cn", "representative": "zf_001", "members": ["zf_001", "zf_018", "zf_021", "zf_042"]},
  {"category": "zh-female", "locale": "zh-cn", "representative": "zf_002", "members": ["zf_002", "zf_003", "zf_006", "zf_007", "zf_008", "zf_023", "zf_026", "zf_036", "zf_088"]},
  {"category": "zh-female", "locale": "zh-cn", "representative": "zf_004", "members": ["zf_004", "zf_005", "zf_028"]},
  {"category": "zh-female", "locale": "zh-cn", "representative": "zf_019", "members": ["zf_019", "zf_099"]},
  {"category": "zh-female", "locale": "zh-cn", "representative": "zf_022", "members": ["zf_022", "zf_027", "zf_094"]},
  {"category": "zh-female", "locale": "zh-cn", "representative": "zf_038", "members": ["zf_038"]},
  {"category": "zh-female", "locale": "zh-cn", "representative": "zf_046", "members": ["zf_046", "zf_079"]},
  {"category": "zh-female", "locale": "zh-cn", "representative": "zf_047", "members": ["zf_032", "zf_040", "zf_047", "zf_051"]},
  {"category": "zh-female", "locale": "zh-cn", "representative": "zf_059", "members": ["zf_039", "zf_044", "zf_048", "zf_049", "zf_059", "zf_060"]},
  {"category": "zh-female", "locale": "zh-cn", "representative": "zf_067", "members": ["zf_024", "zf_067", "zf_071", "zf_075", "zf_076", "zf_077", "zf_078", "zf_083", "zf_085", "zf_086", "zf_087", "zf_092"]},
  {"category": "zh-female", "locale": "zh-cn", "representative": "zf_073", "members": ["zf_070", "zf_073", "zf_074", "zf_084"]},
  {"category": "zh-female", "locale": "zh-cn", "representative": "zf_093", "members": ["zf_017", "zf_043", "zf_072", "zf_090", "zf_093"]},
  {"category": "en-female", "locale": "en-us", "representative": "af_maple", "members": ["af_maple"]},
  {"category": "en-female", "locale": "en-us", "representative": "af_sol", "members": ["af_sol"]},
  {"category": "en-female", "locale": "en-gb", "representative": "bf_vale", "members": ["bf_vale"]},
]
