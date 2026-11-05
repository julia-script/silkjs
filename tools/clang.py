#!/usr/bin/env python3
"""Clang driver selected by the Darwin build to reserve SEA load-command space."""
import os
import sys

arguments = sys.argv[1:]
# Compilation, inspection, preprocessing, and relocatable links do not produce
# the executable whose Mach-O header the injector extends.
non_final = {'-c', '-S', '-E', '-r', '--version', '-v', '-###', '-dumpmachine', '-dumpversion'}
if arguments and not non_final.intersection(arguments):
    arguments = [arg for arg in arguments if not arg.endswith('/libsilk_napi.a')]
    if sys.platform == 'darwin':
        # Addons resolve Node-API against the executable. Do not let dead-strip
        # discard unreferenced ABI entry points from the static bridge archive.
        arguments += ['-Wl,-headerpad,0x1000', '-Wl,-export_dynamic',
                      '-Wl,-force_load,' + os.path.join(os.path.dirname(__file__), '../build/native/libsilk_napi.a')]
    else:
        arguments = ['-Wl,--export-dynamic', '-Wl,--whole-archive',
                     os.path.join(os.path.dirname(__file__), '../build/native/libsilk_napi.a'),
                     '-Wl,--no-whole-archive', *arguments, '-ldl']
compiler = os.environ.get('SILK_CLANG', 'clang')
os.execvp(compiler, [compiler, *arguments])
