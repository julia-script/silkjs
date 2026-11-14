#!/usr/bin/env python3
"""Clang driver for the runtime's build: final-link flags, and a link that can be repeated."""
import json
import os
import shutil
import subprocess
import sys

BUILD = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'build')
# Another program of this package (tools/embed_smoke.py) keeps its link apart from the executable's.
BUILD = os.environ.get('SILKJS_CLANG_BUILD', BUILD)
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
        # Link with lld when there is one (beside the compiler, or on PATH): only lld
        # takes the function order (build.py startup_order) that keeps the code a
        # start and a server run together, in fewer resident pages.
        if not any(a.startswith(('--ld-path=', '-fuse-ld=')) for a in arguments):
            beside = os.path.join(os.path.dirname(shutil.which(compiler) or compiler), 'ld.lld')
            lld = beside if os.access(beside, os.X_OK) else shutil.which('ld.lld')
            if lld:
                arguments = ['--ld-path=' + lld, *arguments]
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
            # One section per function, so that the link can order them (build.py, startup_order).
            sections = [] if sys.platform == 'darwin' else ['-ffunction-sections']
            subprocess.run([compiler, *compile_only, *sections, '-c', '-o', program], check=True)
            arguments[at:at + 5] = [program]
            # Code generation options have nothing left to apply to.
            while '-mllvm' in arguments:
                del arguments[arguments.index('-mllvm'):arguments.index('-mllvm') + 2]
    # tools/build.py's build identity (src/ext/builtin_cache.c), which outranks the weak default.
    # It names the object in a file: the compiler server that runs this may predate the build.
    extra = os.path.join(BUILD, 'link-object')
    if os.path.isfile(extra):
        with open(extra) as named:
            arguments.append(named.read().strip())
    # A Silk that compiles the program to an object itself (one kept beside the output)
    # links that object: record every final link, not only one from IR.
    os.makedirs(BUILD, exist_ok=True)
    with open(os.path.join(BUILD, 'link-command.json'), 'w') as record:
        json.dump({'directory': os.getcwd(), 'compiler': compiler, 'arguments': arguments}, record)
elif '-c' in arguments and '-x' in arguments and arguments[arguments.index('-x') + 1] == 'ir' and sys.platform != 'darwin':
    # The program's own compile, by such a Silk: one section per function, as above.
    arguments.append('-ffunction-sections')
os.execvp(compiler, [compiler, *arguments])
