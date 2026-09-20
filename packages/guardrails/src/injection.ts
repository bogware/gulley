import type { Detector, Finding } from './types';

/**
 * Native prompt-injection / jailbreak heuristics -- a local, egress-free classifier
 * plugged in behind the {@link Detector} interface (M20), so an operator can `block`
 * or `audit` injection attempts under the guardrail input policy without a paid
 * managed service. Categories: `prompt_injection` (instruction-override, fake
 * role/system turns, decode-and-execute obfuscation) and `jailbreak` (persona /
 * restriction-removal framing). Patterns are bounded (RE2-safe, no catastrophic
 * backtracking). Confidences are moderate on purpose -- pair with `minConfidence`
 * and category scoping so PII can `audit` while injection `block`s.
 *
 * This is a heuristic first pass; an embedding-nearest-known-attack mode (reusing
 * the M16 centroid infra) is a documented enhancement.
 */
interface InjectionPattern {
  re: RegExp;
  category: 'prompt_injection' | 'jailbreak';
  confidence: number;
}

const PATTERNS: InjectionPattern[] = [
  // Instruction override: "ignore/disregard the previous/above instructions".
  {
    re: /\b(?:ignore|disregard|forget|override|bypass)\b[\s\S]{0,32}\b(?:previous|prior|above|earlier|all|any|these|the)\b[\s\S]{0,24}\b(?:instructions?|prompts?|rules?|guidelines?|context|messages?|directions?)\b/gi,
    category: 'prompt_injection',
    confidence: 0.85,
  },
  // System-prompt exfiltration: "reveal / repeat your system prompt / instructions".
  {
    re: /\b(?:reveal|show|print|repeat|output|display|tell me|what are)\b[\s\S]{0,32}\b(?:system prompt|your (?:instructions|prompt|rules)|initial (?:instructions|prompt)|the prompt above)\b/gi,
    category: 'prompt_injection',
    confidence: 0.8,
  },
  // Injected chat-template role/turn markers inside user content.
  {
    re: /<\|(?:im_start|im_end|system|assistant|user)\|>/gi,
    category: 'prompt_injection',
    confidence: 0.85,
  },
  { re: /\[\/?(?:INST|SYS|SYSTEM)\]/gi, category: 'prompt_injection', confidence: 0.7 },
  {
    re: /(?:^|\n)\s*(?:system|assistant|developer)\s*:/gi,
    category: 'prompt_injection',
    confidence: 0.55,
  },
  // Decode-then-execute obfuscation.
  {
    re: /\b(?:base64|rot13|hex|decode)\b[\s\S]{0,40}\b(?:then|and)\b[\s\S]{0,16}\b(?:execute|run|follow|obey|do it|comply)\b/gi,
    category: 'prompt_injection',
    confidence: 0.7,
  },
  // Jailbreak personas / restriction removal.
  {
    re: /\b(?:DAN|do anything now|developer mode|jailbreak(?:en)?|STAN|AIM mode)\b/gi,
    category: 'jailbreak',
    confidence: 0.6,
  },
  {
    re: /\byou are (?:now )?(?:a |an )?(?:unrestricted|uncensored|unfiltered|amoral|evil|dangerous|rogue)\b/gi,
    category: 'jailbreak',
    confidence: 0.75,
  },
  {
    re: /\b(?:no|without any|ignore (?:your|all)|drop (?:your|all))\b[\s\S]{0,16}\b(?:restrictions?|limitations?|guidelines?|safety|filters?|rules?)\b/gi,
    category: 'jailbreak',
    confidence: 0.65,
  },
  {
    re: /\bpretend (?:you (?:are|can)|to be)\b[\s\S]{0,32}\b(?:no (?:rules|restrictions)|anything|unrestricted|not an ai)\b/gi,
    category: 'jailbreak',
    confidence: 0.6,
  },
];

// Zero-width / invisible characters used to smuggle instructions past filters. A
// RUN is one finding: flagging each character produced a finding per code point
// (a megabyte of U+200B = a million findings) and overwhelmed overlap resolution.
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]+/g;

/** Scan bound (UTF-16 code units), matching the native detector's default. */
const DEFAULT_MAX_SCAN = 4 * 1024 * 1024;
const MAX_INJECTION_FINDINGS = 2_000;

export class InjectionDetector implements Detector {
  readonly name = 'injection';

  constructor(private readonly maxScanChars = DEFAULT_MAX_SCAN) {}

  detect(full: string): Finding[] {
    const text = full.length > this.maxScanChars ? full.slice(0, this.maxScanChars) : full;
    const findings: Finding[] = [];
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      for (let m = p.re.exec(text); m !== null; m = p.re.exec(text)) {
        if (m[0].length === 0) {
          p.re.lastIndex++;
          continue;
        }
        findings.push({
          category: p.category,
          start: m.index,
          end: m.index + m[0].length,
          source: 'pattern',
          confidence: p.confidence,
        });
      }
    }
    // Zero-width obfuscation: flag each invisible run.
    ZERO_WIDTH.lastIndex = 0;
    for (let m = ZERO_WIDTH.exec(text); m !== null; m = ZERO_WIDTH.exec(text)) {
      findings.push({
        category: 'prompt_injection',
        start: m.index,
        end: m.index + m[0].length,
        source: 'pattern',
        confidence: 0.6,
      });
      if (findings.length >= MAX_INJECTION_FINDINGS) break;
    }
    return findings;
  }
}
