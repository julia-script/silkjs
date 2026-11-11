#!/usr/bin/env python3
"""Clang driver for the runtime's build: final-link flags, and a link that can be repeated."""
import json
import os
import subprocess
import sys

BUILD = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'build')
arguments = sys.argv[1:]
compiler = os.environ.get('SILK_CLANG', 'clang')
# Compilation, inspection, preprocessing, and relocatable links do not produce
# the executable whose Mach-O header the injector extends.
non_final = {'-c', '-S', '-E', '-r', '--version', '-v', '-###', '-dumpmachine', '-dumpversion'}
if arguments and not non_final.intersection(arguments):
    if sys.platform == 'darwin':
        # Addons resolve Node-API against the executable, so keep its exports visible.
        arguments += ['-Wl,-headerpad,0x1000', '-Wl,-export_dynamic']
    else:
        arguments = ['-Wl,--export-dynamic', *arguments, '-ldl']
    # tools/build.py links a second time, with the built-ins' bytecode. Silk hands the
    # program over as LLVM IR in a temporary file, so compile that to an object that
    # stays, link the object, and record the link for build.py to repeat.
    if '-x' in arguments and arguments[arguments.index('-x') + 1] == 'ir':
        at = arguments.index('-x')
        if arguments[at + 3:at + 5] == ['-x', 'none']:
            program = os.path.join(BUILD, 'program.o')
            os.makedirs(BUILD, exist_ok=True)
            output = arguments.index('-o')
            compile_only = arguments[:output] + arguments[output + 2:]
            compile_only = [argument for argument in compile_only
                            if not argument.startswith(('-Wl,', '-l', '--ld-path=')) and argument != '-no-pie'
                            and not argument.endswith(('.a', '.o'))]
            subprocess.run([compiler, *compile_only, '-c', '-o', program], check=True)
            arguments[at:at + 5] = [program]
            # Code generation options have nothing left to apply to.
            while '-mllvm' in arguments:
                del arguments[arguments.index('-mllvm'):arguments.index('-mllvm') + 2]
            with open(os.path.join(BUILD, 'link-command.json'), 'w') as record:
                json.dump({'directory': os.getcwd(), 'compiler': compiler, 'arguments': arguments}, record)
os.execvp(compiler, [compiler, *arguments])
