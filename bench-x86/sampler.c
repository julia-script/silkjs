// LD_PRELOAD=./sampler.so SAMPLES_OUT=s.txt ./silkjs fx.js -> hex RIPs, one per line
#define _GNU_SOURCE
#include <signal.h>
#include <sys/time.h>
#include <ucontext.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
static unsigned long *buf; static size_t n, cap = 1<<22;
static void handler(int sig, siginfo_t *si, void *uc_) { ucontext_t *uc = uc_; if (n < cap) buf[n++] = uc->uc_mcontext.gregs[REG_RIP]; }
__attribute__((constructor)) static void start(void) {
  buf = malloc(cap*sizeof *buf);
  struct sigaction sa; memset(&sa,0,sizeof sa); sa.sa_sigaction = handler; sa.sa_flags = SA_SIGINFO|SA_RESTART; sigaction(SIGPROF,&sa,0);
  timer_t t; struct sigevent ev; memset(&ev,0,sizeof ev); ev.sigev_notify=SIGEV_THREAD_ID; ev._sigev_un._tid=gettid(); ev.sigev_signo=SIGPROF;
  timer_create(CLOCK_THREAD_CPUTIME_ID,&ev,&t); struct itimerspec its={{0,50000},{0,50000}}; timer_settime(t,0,&its,0);
}
__attribute__((destructor)) static void stop(void) {
  const char *p = getenv("SAMPLES_OUT"); FILE *f = fopen(p?p:"samples.txt","w");
  for (size_t i=0;i<n;i++) fprintf(f,"%lx\n",buf[i]); fclose(f);
}
