#!/usr/bin/env python3
"""Clang driver selected by the Darwin build to reserve SEA load-command space."""
import os
import sys

arguments = sys.argv[1:]
# Compilation, inspection, preprocessing, and relocatable links do not produce
# the executable whose Mach-O header the injector extends.
non_final = {'-c', '-S', '-E', '-r', '--version', '-v', '-###', '-dumpmachine', '-dumpversion'}
if arguments and not non_final.intersection(arguments):
    if sys.platform == 'darwin':
        # Addons resolve Node-API against the executable, so keep its exports visible.
        arguments += ['-Wl,-headerpad,0x1000', '-Wl,-export_dynamic']
    else:
        arguments = ['-Wl,--export-dynamic', *arguments, '-ldl']
compiler = os.environ.get('SILK_CLANG', 'clang')
os.execvp(compiler, [compiler, *arguments])
