#define _XOPEN_SOURCE 700
#define _DARWIN_C_SOURCE
#include <signal.h>
#include <sys/time.h>
#include <sys/ucontext.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <mach-o/dyld.h>
static unsigned long *buf; static size_t n, cap = 1<<22;
static void handler(int sig, siginfo_t *si, void *uc_) { ucontext_t *uc = uc_; if (n < cap) buf[n++] = __darwin_arm_thread_state64_get_pc(uc->uc_mcontext->__ss); }
__attribute__((constructor)) static void start(void) {
  buf = malloc(cap*sizeof *buf);
  struct sigaction sa; memset(&sa,0,sizeof sa); sa.sa_sigaction = handler; sa.sa_flags = SA_SIGINFO|SA_RESTART; sigaction(SIGPROF,&sa,0);
  struct itimerval it = {{0,200},{0,200}}; setitimer(ITIMER_PROF,&it,0);
}
__attribute__((destructor)) static void stop(void) {
  const char *p = getenv("SAMPLES_OUT"); FILE *f = fopen(p?p:"samples.txt","w");
  for (unsigned i=0;i<_dyld_image_count();i++){const char*nm=_dyld_get_image_name(i); if(strstr(nm,"silkjs")) fprintf(f,"slide %lx\n",(unsigned long)_dyld_get_image_vmaddr_slide(i));}
  for (size_t i=0;i<n;i++) fprintf(f,"%lx\n",buf[i]); fclose(f);
}
