// SPDX-License-Identifier: MIT
// Chinese number normalization for the native speech frontend.
// The supported an2cn pipeline and integer conversion are ported from cn2an
// 0.5.23 (Copyright (c) 2017 Ailln). See licenses/speech-models/cn2an-LICENSE.
// Input order and fallback behavior intentionally match the evaluated frontend.

const DIGITS: [&str; 10] = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const UNITS: [&str; 16] = [
    "", "十", "百", "千", "万", "十", "百", "千", "亿", "十", "百", "千", "万", "十", "百", "千",
];

fn decimal_digit(c: char) -> bool {
    // Unicode decimal digits, as matched by the upstream Python \d expression.
    const RANGES: &[(u32, u32)] = &[
        (0x30, 0x39),
        (0x660, 0x669),
        (0x6F0, 0x6F9),
        (0x7C0, 0x7C9),
        (0x966, 0x96F),
        (0x9E6, 0x9EF),
        (0xA66, 0xA6F),
        (0xAE6, 0xAEF),
        (0xB66, 0xB6F),
        (0xBE6, 0xBEF),
        (0xC66, 0xC6F),
        (0xCE6, 0xCEF),
        (0xD66, 0xD6F),
        (0xDE6, 0xDEF),
        (0xE50, 0xE59),
        (0xED0, 0xED9),
        (0xF20, 0xF29),
        (0x1040, 0x1049),
        (0x1090, 0x1099),
        (0x17E0, 0x17E9),
        (0x1810, 0x1819),
        (0x1946, 0x194F),
        (0x19D0, 0x19D9),
        (0x1A80, 0x1A89),
        (0x1A90, 0x1A99),
        (0x1B50, 0x1B59),
        (0x1BB0, 0x1BB9),
        (0x1C40, 0x1C49),
        (0x1C50, 0x1C59),
        (0xA620, 0xA629),
        (0xA8D0, 0xA8D9),
        (0xA900, 0xA909),
        (0xA9D0, 0xA9D9),
        (0xA9F0, 0xA9F9),
        (0xAA50, 0xAA59),
        (0xABF0, 0xABF9),
        (0xFF10, 0xFF19),
        (0x104A0, 0x104A9),
        (0x10D30, 0x10D39),
        (0x11066, 0x1106F),
        (0x110F0, 0x110F9),
        (0x11136, 0x1113F),
        (0x111D0, 0x111D9),
        (0x112F0, 0x112F9),
        (0x11450, 0x11459),
        (0x114D0, 0x114D9),
        (0x11650, 0x11659),
        (0x116C0, 0x116C9),
        (0x11730, 0x11739),
        (0x118E0, 0x118E9),
        (0x11950, 0x11959),
        (0x11C50, 0x11C59),
        (0x11D50, 0x11D59),
        (0x11DA0, 0x11DA9),
        (0x11F50, 0x11F59),
        (0x16A60, 0x16A69),
        (0x16AC0, 0x16AC9),
        (0x16B50, 0x16B59),
        (0x1D7CE, 0x1D7FF),
        (0x1E140, 0x1E149),
        (0x1E2F0, 0x1E2F9),
        (0x1E4F0, 0x1E4F9),
        (0x1E950, 0x1E959),
        (0x1FBF0, 0x1FBF9),
    ];
    RANGES
        .iter()
        .any(|&(start, end)| (start..=end).contains(&(c as u32)))
}

fn digit_value(c: char) -> Option<usize> {
    match c {
        '0'..='9' => Some(c as usize - '0' as usize),
        '０'..='９' => Some(c as usize - '０' as usize),
        _ => None,
    }
}

fn number(input: &[char], direct: bool) -> Option<String> {
    let (negative, input) = if input.first() == Some(&'-') {
        (true, &input[1..])
    } else {
        (false, input)
    };
    let mut output = if negative {
        "负".to_owned()
    } else {
        String::new()
    };
    if direct {
        for &c in input {
            output.push_str(if c == '.' {
                "点"
            } else {
                DIGITS[digit_value(c)?]
            });
        }
        return Some(output);
    }
    let split = input.iter().position(|&c| c == '.').unwrap_or(input.len());
    let integer: Vec<_> = input[..split]
        .iter()
        .map(|&c| digit_value(c))
        .collect::<Option<_>>()?;
    if integer.is_empty() {
        return None;
    }
    let first = integer
        .iter()
        .position(|&n| n != 0)
        .unwrap_or(integer.len() - 1);
    let integer = &integer[first..];
    if integer.len() > UNITS.len() {
        return None;
    }
    let mut words = String::new();
    for (i, &n) in integer.iter().enumerate() {
        let position = integer.len() - i - 1;
        if n != 0 {
            words.push_str(DIGITS[n]);
            words.push_str(UNITS[position]);
        } else {
            if position % 4 == 0 {
                words.push_str("零");
                words.push_str(UNITS[position]);
            }
            if i > 0 && !words.ends_with('零') {
                words.push_str("零");
            }
        }
    }
    words = words
        .replace("零零", "零")
        .replace("零万", "万")
        .replace("零亿", "亿")
        .replace("亿万", "亿");
    words = words.trim_matches('零').to_owned();
    if words.starts_with("一十") {
        words = words['一'.len_utf8()..].to_owned();
    }
    output.push_str(if words.is_empty() { "零" } else { &words });
    if split < input.len() - 1 {
        output.push_str("点");
        for &c in input[split + 1..].iter().take(16) {
            output.push_str(DIGITS[digit_value(c)?]);
        }
    }
    Some(output)
}

fn digits_end(chars: &[char], start: usize) -> usize {
    let mut end = start;
    while chars.get(end).copied().is_some_and(decimal_digit) {
        end += 1;
    }
    end
}

fn number_end(chars: &[char], start: usize) -> usize {
    let digits = start + usize::from(chars.get(start) == Some(&'-'));
    let integer_end = digits_end(chars, digits);
    if integer_end == digits {
        return start;
    }
    if chars.get(integer_end) == Some(&'.') {
        let decimal_end = digits_end(chars, integer_end + 1);
        if decimal_end > integer_end + 1 {
            return decimal_end;
        }
    }
    integer_end
}

fn transform(input: &str, stage: usize) -> String {
    let chars: Vec<_> = input.chars().collect();
    let mut output = String::with_capacity(input.len());
    let mut start = 0;
    while start < chars.len() {
        let mut end = start;
        let mut replacement = None;
        match stage {
            0 => {
                let mut words = String::new();
                let mut valid = true;
                for (unit, min, max, direct) in
                    [('年', 2, 4, true), ('月', 1, 2, false), ('日', 1, 2, false)]
                {
                    let count = chars[end..]
                        .iter()
                        .take(max + 1)
                        .take_while(|&&c| decimal_digit(c))
                        .count();
                    if (min..=max).contains(&count) && chars.get(end + count) == Some(&unit) {
                        if let Some(part) = number(&chars[end..end + count], direct) {
                            words.push_str(&part);
                        } else {
                            valid = false;
                        }
                        words.push(unit);
                        end += count + 1;
                    }
                }
                if end > start && valid {
                    replacement = Some(words);
                }
            }
            1 => {
                let numerator_end = digits_end(&chars, start);
                end = numerator_end;
                if numerator_end > start && chars.get(numerator_end) == Some(&'/') {
                    let denominator_end = digits_end(&chars, numerator_end + 1);
                    if denominator_end > numerator_end + 1 {
                        end = denominator_end;
                        if let (Some(numerator), Some(denominator)) = (
                            number(&chars[start..numerator_end], false),
                            number(&chars[numerator_end + 1..end], false),
                        ) {
                            replacement = Some(format!("{denominator}分之{numerator}"));
                        }
                    }
                }
            }
            2 => {
                let numeric_end = number_end(&chars, start);
                // A failed decimal-percent match can begin again after its
                // first dot (e.g. 12.3.4%). Skip only the integer prefix.
                end = digits_end(&chars, start + usize::from(chars.get(start) == Some(&'-')));
                if numeric_end > start && chars.get(numeric_end) == Some(&'%') {
                    end = numeric_end + 1;
                    replacement =
                        number(&chars[start..numeric_end], false).map(|n| format!("百分之{n}"));
                }
            }
            3 => {
                let numeric_end = digits_end(&chars, start);
                end = numeric_end;
                if numeric_end > start && chars.get(numeric_end) == Some(&'℃') {
                    end = numeric_end + 1;
                    replacement =
                        number(&chars[start..numeric_end], false).map(|n| format!("{n}摄氏度"));
                }
            }
            _ => {
                end = number_end(&chars, start);
                if end > start {
                    replacement = number(&chars[start..end], false);
                }
            }
        }
        if end == start {
            end += 1;
        }
        if let Some(replacement) = replacement {
            output.push_str(&replacement);
        } else {
            output.extend(&chars[start..end]);
        }
        start = end;
    }
    output
}

/// Normalize numbers before the native Chinese phoneme frontend. Unconvertible
/// tokens are preserved, and ordinary letters, punctuation and text are unchanged.
pub fn normalize_chinese(text: &str) -> String {
    (0..5).fold(text.to_owned(), |text, stage| transform(&text, stage))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_pinned_chinese_frontend_fixtures() {
        for (line, fixture) in include_str!("../../tests/fixtures/speech-chinese-normalizer.tsv")
            .lines()
            .enumerate()
        {
            let (input, expected) = fixture.split_once('\t').unwrap();
            assert_eq!(
                normalize_chinese(input),
                expected,
                "normalizer fixture line {}: {input}",
                line + 1
            );
        }
    }
}
