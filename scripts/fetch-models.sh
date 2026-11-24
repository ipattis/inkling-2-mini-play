#!/usr/bin/env bash
# Download the two GGUFs straight from huggingface.co with curl (resumable),
# then check each file's SHA-256 against the Hub's LFS hash.
# Used instead of `hf download` because the Xet CDN was returning 502s and the
# hf CLI's Python TLS stack rejected this network's certificate chain.
set -euo pipefail
DEST="${HF_GGUF_DIR:-$HOME/.cache/huggingface/gguf}"

fetch() { # repo file sha256 size
  local repo="$1" file="$2" sha="$3" size="$4"
  local dir="$DEST/$repo" out="$DEST/$repo/$file"
  mkdir -p "$dir"
  if [[ -f "$out" ]]; then echo "✓ $repo/$file already present"; return; fi
  echo "↓ $repo/$file ($((size / 1000000000)) GB)"
  until curl -L --fail --retry 30 --retry-delay 5 --retry-all-errors -C - \
      -o "$out.part" "https://huggingface.co/$repo/resolve/main/$file"; do
    echo "  retrying $file…"; sleep 5
  done
  local got; got=$(stat -f %z "$out.part")
  [[ "$got" == "$size" ]] || { echo "✗ size mismatch for $file: $got != $size"; exit 1; }
  echo "  verifying sha256…"
  local sum; sum=$(shasum -a 256 "$out.part" | cut -d' ' -f1)
  [[ "$sum" == "$sha" ]] || { echo "✗ sha256 mismatch for $file"; exit 1; }
  mv "$out.part" "$out"
  echo "✓ $repo/$file verified"
}

which="${1:-all}"
if [[ "$which" == all || "$which" == inkling ]]; then
  fetch ggml-org/Inkling-2-Mini-GGUF Inkling-2-Mini-Q8_0.gguf \
    d57542f8aea5d7639beba5fc4ae7f584754916f63ac5d5a69328c27f652f45da 27820099264
fi
if [[ "$which" == all || "$which" == qwen ]]; then
  fetch unsloth/Qwen3.8-27B-GGUF Qwen3.8-27B-Q8_0.gguf \
    a680f44a06920e5d689774823782006aa3acc8db95750323373b24139b67e348 29047086048
fi
