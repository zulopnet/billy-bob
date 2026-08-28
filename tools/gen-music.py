#!/usr/bin/env python3
"""Batch-generate banjo beds with ACE-Step 1.5.

    python tools/gen-music.py out/ tools/music-spec.json

Loads the DiT and the 5Hz LM once and renders every entry in the spec, because
the load costs ~15s and each render only ~5s. Needs a checkout of ACE-Step 1.5
at REPO, its venv, and the GPU to itself.

The takes it writes are NOT loops — they open with an intro and close with a
fade-out. Run tools/loopify.py on the one you pick.

`timesignature` must be a string ("4/4"); ACE-Step's own docstring says int and
its code calls .strip() on it.

Seeds are recorded, not trusted: the seed in the spec is not what ACE-Step
reports back, so treat a re-render as a new take rather than a reproduction of
the old one. The shipped bed is src/audio/store-loop.ogg — keep it, do not
expect to regenerate it.
"""
import json, os, sys, time
from pathlib import Path

REPO = "/home/bob/ACE-Step-1.5"
sys.path.insert(0, REPO)

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/bbmusic/out")
SPEC = Path(sys.argv[2]) if len(sys.argv) > 2 else None

TRACKS = json.loads(SPEC.read_text()) if SPEC else []


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    from acestep.handler import AceStepHandler
    from acestep.llm_inference import LLMHandler
    from acestep.inference import GenerationParams, GenerationConfig, generate_music

    t0 = time.time()
    print("[ace] loading turbo DiT + 5Hz LM", flush=True)
    dit = AceStepHandler()
    dit.initialize_service(project_root=REPO, config_path="acestep-v15-turbo", device="cuda")
    llm = LLMHandler()
    llm.initialize(checkpoint_dir=os.path.join(REPO, "checkpoints"),
                   lm_model_path="acestep-5Hz-lm-1.7B", backend="pt", device="cuda")
    print(f"[ace] ready in {time.time()-t0:.0f}s", flush=True)

    for spec in TRACKS:
        name = spec["name"]
        kw = dict(
            task_type="text2music",
            caption=spec["caption"],
            lyrics="[Instrumental]",
            instrumental=True,
            duration=float(spec.get("duration", 60)),
            inference_steps=int(spec.get("steps", 8)),
            seed=int(spec.get("seed", -1)),
            thinking=True,
        )
        if spec.get("bpm"):
            kw["bpm"] = int(spec["bpm"])
        if spec.get("key"):
            kw["keyscale"] = spec["key"]
        if spec.get("timesig"):
            kw["timesignature"] = str(spec["timesig"])

        t1 = time.time()
        res = generate_music(dit, llm, GenerationParams(**kw),
                             GenerationConfig(batch_size=1, audio_format="wav"),
                             save_dir=str(OUT))
        if not getattr(res, "success", False):
            print(f"[ace] FAILED {name}: {getattr(res, 'error', '?')}", flush=True)
            continue
        for a in res.audios:
            src = Path(a["path"])
            dest = OUT / f"{name}{src.suffix}"
            if src.resolve() != dest.resolve():
                src.replace(dest)
            print(f"[ace] {dest.name}  key={a.get('key')} "
                  f"seed={a.get('params', {}).get('seed')} {time.time()-t1:.0f}s", flush=True)


if __name__ == "__main__":
    main()
