#!/usr/bin/env python3
"""Cold start benchmark: wall time, CPU time, peak RSS and page faults per process start.

usage: coldstart.py RUNS OUT.json name=command... [--only case,case] [--cases DIR]

Each command is split on spaces and gets the script path appended. Runs are interleaved across
runtimes so host noise hits all of them alike; the reported time is the median, with the minimum
beside it. One warm-up run per pair is discarded (it pulls the binary into the page cache).
"""
import json
import os
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def run(argv, cwd):
    devnull_in = os.open(os.devnull, os.O_RDONLY)
    devnull_out = os.open(os.devnull, os.O_WRONLY)
    start = time.perf_counter()
    pid = os.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
            os.dup2(devnull_in, 0)
            os.dup2(devnull_out, 1)
            os.dup2(devnull_out, 2)
            environment = {key: value for key, value in os.environ.items() if key != 'NODE_OPTIONS'}
            os.execve(argv[0], argv, environment)
        finally:
            os._exit(127)
    _, status, usage = os.wait4(pid, 0)
    wall = time.perf_counter() - start
    os.close(devnull_in)
    os.close(devnull_out)
    return {
        'ok': os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0,
        'wall_ms': wall * 1000,
        'cpu_ms': (usage.ru_utime + usage.ru_stime) * 1000,
        'rss_mb': usage.ru_maxrss / 1024,
        'faults': usage.ru_minflt + usage.ru_majflt,
    }


def main():
    arguments = sys.argv[1:]
    runs, output = int(arguments[0]), arguments[1]
    only, cases_dir, runtimes = None, os.path.join(HERE, 'cases'), []
    index = 2
    while index < len(arguments):
        argument = arguments[index]
        if argument == '--only':
            index += 1
            only = arguments[index].split(',')
        elif argument == '--cases':
            index += 1
            cases_dir = arguments[index]
        else:
            name, command = argument.split('=', 1)
            runtimes.append((name, command.split(' ')))
        index += 1
    cases = sorted(entry for entry in os.listdir(cases_dir) if entry.endswith(('.js', '.mjs', '.cjs')))
    if only:
        cases = [case for case in cases if case.rsplit('.', 1)[0] in only]
    results = {}
    for case in cases:
        label = case.rsplit('.', 1)[0]
        samples = {name: [] for name, _ in runtimes}
        for name, command in runtimes:
            run(command + [case], cases_dir)
        for _ in range(runs):
            for name, command in runtimes:
                samples[name].append(run(command + [case], cases_dir))
        results[label] = {}
        for name, _ in runtimes:
            rows = samples[name]
            results[label][name] = {
                'ok': all(row['ok'] for row in rows),
                'wall_ms': round(statistics.median(row['wall_ms'] for row in rows), 2),
                'wall_min_ms': round(min(row['wall_ms'] for row in rows), 2),
                'cpu_ms': round(statistics.median(row['cpu_ms'] for row in rows), 2),
                'rss_mb': round(statistics.median(row['rss_mb'] for row in rows), 1),
                'faults': int(statistics.median(row['faults'] for row in rows)),
            }
    with open(output, 'w') as handle:
        json.dump(results, handle, indent=1)
    names = [name for name, _ in runtimes]
    for metric, title, form in (('wall_ms', 'wall ms (median)', '%.1f'), ('cpu_ms', 'user+sys ms', '%.1f'),
                                ('rss_mb', 'peak RSS MB', '%.1f'), ('faults', 'page faults', '%d')):
        print('\n' + title)
        print('%-10s' % 'case' + ''.join('%14s' % name for name in names))
        for label, row in results.items():
            print('%-10s' % label + ''.join(
                '%14s' % ((form % row[name][metric]) + ('' if row[name]['ok'] else '!')) for name in names))


if __name__ == '__main__':
    main()
