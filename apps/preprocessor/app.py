from __future__ import annotations

import inspect
import re
from typing import Dict, List, Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field
from razdel import sentenize

if not hasattr(inspect, "getargspec"):
    from collections import namedtuple

    ArgSpec = namedtuple("ArgSpec", ["args", "varargs", "keywords", "defaults"])

    def _compat_getargspec(func):  # pragma: no cover
        spec = inspect.getfullargspec(func)
        return ArgSpec(spec.args, spec.varargs, spec.varkw, spec.defaults)

    inspect.getargspec = _compat_getargspec  # type: ignore[attr-defined]

try:
    import pymorphy2  # type: ignore
except Exception:  # pragma: no cover
    pymorphy2 = None

try:
    from yargy import Parser, rule
    from yargy.predicates import is_capitalized
except Exception:  # pragma: no cover
    Parser = None
    rule = None
    is_capitalized = None

app = FastAPI(title="Remarka Preprocessor", version="0.1.0")

WORD_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9-]+", re.UNICODE)
NAME_LIKE_RE = re.compile(
    r"(?:[А-ЯЁ][а-яё]+(?:[-'][А-ЯЁа-яё]+)?)(?:\s+[А-ЯЁ][а-яё]+(?:[-'][А-ЯЁа-яё]+)?){0,2}",
    re.UNICODE,
)
TARGET_CHUNK_WORDS = 1800
MIN_CHUNK_WORDS = 900
CHUNK_OVERLAP_RATIO = 0.12

morph = pymorphy2.MorphAnalyzer() if pymorphy2 else None

YARGY_NAME_PARSER = None
if Parser and rule and is_capitalized:
    try:
        YARGY_NAME_PARSER = Parser(rule(is_capitalized(), is_capitalized().optional(), is_capitalized().optional()))
    except Exception:
        YARGY_NAME_PARSER = None


class PrepassRequest(BaseModel):
    content: str = Field(default="")
    contentVersion: int = Field(default=0)


class ParagraphOut(BaseModel):
    index: int
    text: str
    startOffset: int


class CandidateOut(BaseModel):
    candidateId: str
    text: str
    normalizedText: str
    chunkId: Optional[str] = None
    paragraphIndex: int
    startOffset: int
    endOffset: int
    confidence: float


class SnippetOut(BaseModel):
    snippetId: str
    paragraphIndex: int
    chunkId: Optional[str] = None
    text: str


class ChunkOut(BaseModel):
    chunkId: str
    startOffset: int
    endOffset: int
    text: str
    paragraphStart: int
    paragraphEnd: int


class PrepassResponse(BaseModel):
    contentVersion: int
    paragraphs: List[ParagraphOut]
    candidates: List[CandidateOut]
    snippets: List[SnippetOut]
    chunks: List[ChunkOut]


def canonicalize_content(content: str) -> str:
    normalized = re.sub(r"\r\n?", "\n", content or "")
    lines = [re.sub(r"[\t ]+$", "", line) for line in normalized.split("\n")]
    collapsed = "\n".join(lines).strip()
    return re.sub(r"\n{3,}", "\n\n", collapsed)


def split_paragraphs(content: str) -> List[ParagraphOut]:
    normalized = canonicalize_content(content)
    if not normalized:
        return []

    parts = normalized.split("\n\n")
    paragraphs: List[ParagraphOut] = []
    offset = 0

    for index, text in enumerate(parts):
        paragraphs.append(ParagraphOut(index=index, text=text, startOffset=offset))
        offset += len(text) + 2

    return paragraphs


def paragraph_end_offset(paragraph: ParagraphOut) -> int:
    return paragraph.startOffset + len(paragraph.text)


def paragraph_word_count(paragraph: ParagraphOut) -> int:
    return max(1, len(WORD_RE.findall(paragraph.text)))


def build_chunks(paragraphs: List[ParagraphOut]) -> List[ChunkOut]:
    if not paragraphs:
        return []

    chunks: List[ChunkOut] = []
    i = 0
    chunk_index = 0

    while i < len(paragraphs):
        start = i
        words = 0
        end = i

        while end < len(paragraphs):
            words += paragraph_word_count(paragraphs[end])
            end += 1
            if words >= TARGET_CHUNK_WORDS:
                break

        if words < MIN_CHUNK_WORDS and end < len(paragraphs):
            while end < len(paragraphs) and words < MIN_CHUNK_WORDS:
                words += paragraph_word_count(paragraphs[end])
                end += 1

        end = max(start + 1, min(end, len(paragraphs)))
        chunk_paragraphs = paragraphs[start:end]
        if not chunk_paragraphs:
            break

        chunk_index += 1
        chunks.append(
            ChunkOut(
                chunkId=f"chunk:{chunk_index}",
                startOffset=chunk_paragraphs[0].startOffset,
                endOffset=paragraph_end_offset(chunk_paragraphs[-1]),
                text="\n\n".join(item.text for item in chunk_paragraphs),
                paragraphStart=chunk_paragraphs[0].index,
                paragraphEnd=chunk_paragraphs[-1].index,
            )
        )

        if end >= len(paragraphs):
            break

        overlap_target_words = max(1, int(words * CHUNK_OVERLAP_RATIO))
        overlap_words = 0
        overlap_count = 0
        back = end - 1
        while back >= start:
            overlap_words += paragraph_word_count(paragraphs[back])
            overlap_count += 1
            if overlap_words >= overlap_target_words:
                break
            back -= 1

        next_start = max(start + 1, end - overlap_count)
        i = min(next_start, len(paragraphs))

    return chunks


def find_chunk_id_for_paragraph(chunks: List[ChunkOut], paragraph_index: int) -> Optional[str]:
    for chunk in chunks:
        if chunk.paragraphStart <= paragraph_index <= chunk.paragraphEnd:
            return chunk.chunkId
    return None


def normalize_phrase(text: str) -> str:
    tokens = WORD_RE.findall((text or "").lower())
    if not tokens:
        return ""

    if not morph:
        return " ".join(tokens)

    normalized: List[str] = []
    for token in tokens:
        try:
            parsed = morph.parse(token)
            if parsed:
                normalized.append(parsed[0].normal_form)
            else:
                normalized.append(token)
        except Exception:
            normalized.append(token)

    return " ".join(normalized)


def score_candidate(raw_text: str) -> float:
    words = [w for w in raw_text.split() if w]
    base = 0.55
    bonus = min(0.35, 0.1 * max(0, len(words) - 1))
    return max(0.0, min(1.0, base + bonus))


def extract_with_regex(paragraph_text: str) -> List[re.Match[str]]:
    return list(NAME_LIKE_RE.finditer(paragraph_text))


def extract_with_yargy(paragraph_text: str) -> List[tuple[int, int, str]]:
    if not YARGY_NAME_PARSER:
        return []

    out: List[tuple[int, int, str]] = []
    try:
        for match in YARGY_NAME_PARSER.findall(paragraph_text):
            span = match.span
            value = paragraph_text[span.start : span.stop]
            out.append((span.start, span.stop, value))
    except Exception:
        return []
    return out


def build_candidates(paragraphs: List[ParagraphOut], chunks: List[ChunkOut]) -> List[CandidateOut]:
    candidates: List[CandidateOut] = []
    dedupe: Dict[str, CandidateOut] = {}

    for paragraph in paragraphs:
        regex_matches = extract_with_regex(paragraph.text)
        yargy_matches = extract_with_yargy(paragraph.text)

        raw_spans: List[tuple[int, int, str]] = []
        for match in regex_matches:
            raw_spans.append((match.start(), match.end(), match.group(0)))
        raw_spans.extend(yargy_matches)

        for local_start, local_end, value in raw_spans:
            text = value.strip()
            if not text:
                continue
            normalized = normalize_phrase(text)
            if not normalized:
                continue

            start_offset = paragraph.startOffset + local_start
            end_offset = paragraph.startOffset + local_end
            key = f"{paragraph.index}:{start_offset}:{end_offset}:{normalized}"

            candidate = CandidateOut(
                candidateId=f"cand:{paragraph.index}:{local_start}:{local_end}:{len(candidates)+1}",
                text=text,
                normalizedText=normalized,
                chunkId=find_chunk_id_for_paragraph(chunks, paragraph.index),
                paragraphIndex=paragraph.index,
                startOffset=start_offset,
                endOffset=end_offset,
                confidence=score_candidate(text),
            )
            dedupe[key] = candidate

    candidates = list(dedupe.values())
    candidates.sort(key=lambda item: (item.paragraphIndex, item.startOffset, item.endOffset))
    return candidates


def build_snippets(paragraphs: List[ParagraphOut], candidates: List[CandidateOut], chunks: List[ChunkOut]) -> List[SnippetOut]:
    snippet_map: Dict[int, SnippetOut] = {}

    for candidate in candidates:
        paragraph = paragraphs[candidate.paragraphIndex]
        snippet_map[paragraph.index] = SnippetOut(
            snippetId=f"snip:{paragraph.index}",
            paragraphIndex=paragraph.index,
            chunkId=candidate.chunkId or find_chunk_id_for_paragraph(chunks, paragraph.index),
            text=paragraph.text,
        )

    if not snippet_map:
        for paragraph in paragraphs[:3]:
            snippet_map[paragraph.index] = SnippetOut(
                snippetId=f"snip:{paragraph.index}",
                paragraphIndex=paragraph.index,
                chunkId=find_chunk_id_for_paragraph(chunks, paragraph.index),
                text=paragraph.text,
            )

    snippets = list(snippet_map.values())
    snippets.sort(key=lambda item: item.paragraphIndex)
    return snippets[:128]


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/prepass", response_model=PrepassResponse)
def prepass(payload: PrepassRequest) -> PrepassResponse:
    paragraphs = split_paragraphs(payload.content)
    chunks = build_chunks(paragraphs)
    candidates = build_candidates(paragraphs, chunks)
    snippets = build_snippets(paragraphs, candidates, chunks)

    return PrepassResponse(
        contentVersion=max(0, payload.contentVersion),
        paragraphs=paragraphs,
        candidates=candidates,
        snippets=snippets,
        chunks=chunks,
    )
