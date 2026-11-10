#!/usr/bin/env python3
"""Locate the SilkJS engine the runtime builds against: this repository's modules/engine."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = (ROOT / '../engine').resolve()


def prepare(manifest):
    dependency = manifest['dependencies']['silkjs']
    if 'git' in dependency or 'path' not in dependency:
        raise RuntimeError('SilkJS must be the sibling path dependency "../engine".')
    source = (ROOT / dependency['path']).resolve()
    if source != ENGINE:
        raise RuntimeError(f'SilkJS dependency path must be ../engine, not {dependency["path"]}')
    if not (source / 'silk.toml').is_file():
        raise RuntimeError(f'SilkJS engine manifest is missing: {source / "silk.toml"}')
    return source
