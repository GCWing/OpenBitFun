// macOS-only E2E adapter. Never linked into the product.
#include <dlfcn.h>
#include <errno.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
typedef int (*responsible_fn)(int);
typedef int (*disclaim_fn)(posix_spawnattr_t *, bool);
static pid_t launched_pid = -1;
static void forward_signal(int sig) { if (launched_pid > 0) kill(launched_pid, sig); }
static double seconds(struct timespec t) { return t.tv_sec + t.tv_nsec / 1e9; }
static double cpu_ms(struct rusage_info_v4 r, mach_timebase_info_data_t t) {
  return (double)(r.ri_user_time + r.ri_system_time) * t.numer / t.denom / 1e6;
}
static void json_string(const char *s) {
  putchar('"');
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
    else if (c < 32) printf("\\u%04x", c);
    else putchar(c);
  }
  putchar('"');
}

int main(int argc, char **argv) {
  mach_timebase_info_data_t timebase;
  mach_timebase_info(&timebase);
  if (argc == 2 && !strcmp(argv[1], "self-test")) {
    struct rusage_info_v4 before = {0}, after = {0};
    struct timespec start, end;
    if (proc_pid_rusage(getpid(), RUSAGE_INFO_V4, (rusage_info_t *)&before)) return 2;
    clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &start);
    do { clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &end); } while (seconds(end) - seconds(start) < .1);
    if (proc_pid_rusage(getpid(), RUSAGE_INFO_V4, (rusage_info_t *)&after)) return 2;
    double reference = (seconds(end) - seconds(start)) * 1000;
    double measured = cpu_ms(after, timebase) - cpu_ms(before, timebase);
    printf("{\"referenceCpuMs\":%.4f,\"measuredCpuMs\":%.4f,\"timebaseNumer\":%u,\"timebaseDenom\":%u}\n", reference, measured, timebase.numer, timebase.denom);
    return measured / reference > .95 && measured / reference < 1.05 ? 0 : 3;
  }
  // LLDB uses this dynamically resolved Darwin SPI to launch the target with
  // its own responsibility identity, rather than charging it to the test IDE.
  // https://lldb.llvm.org/cpp_reference/PosixSpawnResponsible_8h_source.html
  if (argc >= 4 && !strcmp(argv[1], "launch")) {
    disclaim_fn disclaim = (disclaim_fn)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
    if (!disclaim) { fprintf(stderr, "Responsibility launch is unavailable\n"); return 2; }
    posix_spawnattr_t attr;
    int err = posix_spawnattr_init(&attr);
    if (err) { fprintf(stderr, "Spawn attributes failed: %s\n", strerror(err)); return 2; }
    err = disclaim(&attr, true);
    if (!err) err = posix_spawn(&launched_pid, argv[3], NULL, &attr, &argv[3], environ);
    posix_spawnattr_destroy(&attr);
    if (err) { fprintf(stderr, "Launch failed: %s\n", strerror(err)); return 2; }
    signal(SIGTERM, forward_signal); signal(SIGINT, forward_signal);
    FILE *pidfile = fopen(argv[2], "w");
    if (!pidfile) { kill(launched_pid, SIGTERM); return 2; }
    fprintf(pidfile, "%d\n", launched_pid); fclose(pidfile);
    int status;
    while (waitpid(launched_pid, &status, 0) < 0) if (errno != EINTR) return 2;
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
  }
  if (argc != 3 || strcmp(argv[1], "sample")) {
    fprintf(stderr, "Usage: probe self-test | launch PIDFILE EXECUTABLE [ARGS] | sample HOST_PID\n"); return 2;
  }
  pid_t host = (pid_t)atoi(argv[2]);
  if (host <= 0) return 2;
  responsible_fn responsible = (responsible_fn)dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
  if (!responsible) { fprintf(stderr, "Responsibility attribution is unavailable\n"); return 2; }
  int host_responsible = responsible(host);
  if (host_responsible != host) {
    fprintf(stderr, "Host responsibility is not isolated: pid=%d responsible=%d\n", host, host_responsible); return 3;
  }
  int capacity = proc_listallpids(NULL, 0) + 512;
  pid_t *pids = calloc((size_t)capacity, sizeof(pid_t));
  if (!pids) return 2;
  int count = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
  if (count < 0 || count >= capacity) { free(pids); return 2; }
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  printf("{\"monotonicMs\":%.4f,\"hostPid\":%d,\"hostResponsiblePid\":%d,\"processes\":[", seconds(now) * 1000, host, host_responsible);
  bool comma = false;
  for (int i = 0; i < count; i++) {
    pid_t pid = pids[i];
    if (pid <= 0 || responsible(pid) != host) continue;
    struct rusage_info_v4 r = {0};
    char name[PROC_PIDPATHINFO_MAXSIZE] = {0};
    proc_name(pid, name, sizeof(name));
    if (comma) putchar(',');
    comma = true;
    printf("{\"pid\":%d,\"responsiblePid\":%d,\"name\":", pid, host); json_string(name);
    if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&r)) { printf(",\"error\":%d}", errno); continue; }
    printf(",\"startTicks\":\"%llu\",\"cpuMs\":%.4f,\"rssBytes\":%llu,\"footprintBytes\":%llu,\"peakFootprintBytes\":%llu,\"idleWakeups\":%llu,\"interruptWakeups\":%llu,\"pageins\":%llu,\"diskReadBytes\":%llu,\"diskWriteBytes\":%llu}",
      r.ri_proc_start_abstime, cpu_ms(r, timebase), r.ri_resident_size, r.ri_phys_footprint,
      r.ri_lifetime_max_phys_footprint, r.ri_pkg_idle_wkups, r.ri_interrupt_wkups, r.ri_pageins,
      r.ri_diskio_bytesread, r.ri_diskio_byteswritten);
  }
  puts("]}"); free(pids); return 0;
}
