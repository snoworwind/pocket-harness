/*
 * Pocket Harness Linux compatibility preload, adapted from TermFold's
 * tools/compat-shim/termfold_compat.c (Apache-2.0; see adjacent LICENSE and NOTICE.md).
 *
 * Preloaded into every guest program through /etc/ld.so.preload, exactly as a distribution
 * would ship a system-wide preload. Two things are fixed here:
 *
 * 1. Hard links. Android refuses link(2) inside an app's storage (EACCES/EPERM from SELinux).
 *    PRoot's --link2symlink used to fake them with a hidden ".l2s" data file kept in the
 *    directory of the first name, which silently breaks as soon as that directory is replaced:
 *    npm updating a package deleted Claude Code's 240 MB binary out from under the other name.
 *    Here a refused link() instead produces an independent copy of the file (a symlink stays a
 *    symlink), with the same mode and timestamps, and link()'s own rules kept: the new name
 *    must not exist, directories cannot be linked. Tools that hard-link to save space or to
 *    move files (dpkg, apt, npm's cache, git, pip, tar) may continue, but this is not hard-link
 *    semantics: updates are independent and duplicate data consumes extra storage. Only
 *    st_nlink stays 1. A link that the kernel allows, or that fails for another reason
 *    (EXDEV, ENOENT, EEXIST, ...), is untouched.
 *
 * 2. dlopen("/proc/self/fd/N"). Under PRoot, re-opening a file through a /proc/self/fd link
 *    reads as empty, so bundles that load libraries from a memfd (Google's .par agents) fail
 *    with "file too short". Such a path is copied through the descriptor into a temp file,
 *    which is loaded instead.
 *
 * Built for the ARM64 Debian rootfs by scripts/source-build/build-linux-assets.sh.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <inttypes.h>
#include <stdint.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif

/* ---- Hard links ------------------------------------------------------------------------- */

/* The raw system call, so the real kernel answer is seen whatever libc does internally. */
static int sys_linkat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, int flags) {
#ifdef DSH_LINK_TEST_FORCE_DENIED
    (void) olddirfd;
    (void) oldpath;
    (void) newdirfd;
    (void) newpath;
    (void) flags;
    errno = EPERM;
    return -1;
#else
    return (int) syscall(SYS_linkat, olddirfd, oldpath, newdirfd, newpath, flags);
#endif
}

static int sys_renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags) {
#ifdef SYS_renameat2
    return (int) syscall(SYS_renameat2, olddirfd, oldpath, newdirfd, newpath, flags);
#else
    (void) olddirfd;
    (void) oldpath;
    (void) newdirfd;
    (void) newpath;
    (void) flags;
    errno = ENOSYS;
    return -1;
#endif
}

static int write_all(int fd, const char *buf, size_t len) {
    while (len > 0) {
        ssize_t w = write(fd, buf, len);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) {
            if (w == 0) errno = EIO;
            return -1;
        }
        buf += w;
        len -= (size_t) w;
    }
    return 0;
}

/* Resolve the target parent once so publication is relative to a stable directory FD. */
static int open_target_parent(int dirfd, const char *path, int *parent_out, char **leaf_out) {
    if (path == NULL) { errno = EFAULT; return -1; }
    size_t length = strnlen(path, PATH_MAX);
    if (length == 0 || length >= PATH_MAX || path[length - 1] == '/') {
        errno = length >= PATH_MAX ? ENAMETOOLONG : ENOENT;
        return -1;
    }
    char *copy = strdup(path);
    if (copy == NULL) { errno = ENOMEM; return -1; }
    char *slash = strrchr(copy, '/');
    char *parent_path = NULL;
    char *leaf = NULL;
    if (slash == NULL) {
        parent_path = strdup(".");
        leaf = strdup(copy);
    } else if (slash == copy) {
        parent_path = strdup("/");
        leaf = strdup(slash + 1);
    } else {
        *slash = '\0';
        parent_path = strdup(copy);
        leaf = strdup(slash + 1);
    }
    free(copy);
    if (parent_path == NULL || leaf == NULL) {
        free(parent_path);
        free(leaf);
        errno = ENOMEM;
        return -1;
    }
    int parent = openat(dirfd, parent_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    int saved = errno;
    free(parent_path);
    if (parent < 0) {
        free(leaf);
        errno = saved;
        return -1;
    }
    *parent_out = parent;
    *leaf_out = leaf;
    return 0;
}

/* Copies to a private sibling and publishes with no-replace rename, so a killed
 * process cannot expose a partially written destination. */
#ifndef DSH_LINK_COPY_MAX_BYTES
#define DSH_LINK_COPY_MAX_BYTES (1024LL * 1024LL * 1024LL)
#endif

static uint64_t link_temp_sequence;

static int copy_regular(int olddirfd, const char *oldpath, int newdirfd, const char *newpath,
                        const struct stat *st, int follow) {
    if (st->st_size < 0 || (uintmax_t) st->st_size > DSH_LINK_COPY_MAX_BYTES) {
        errno = EFBIG;
        return -1;
    }
    int src = openat(olddirfd, oldpath, O_RDONLY | O_CLOEXEC | (follow ? 0 : O_NOFOLLOW));
    if (src < 0) return -1;
    struct stat opened;
    if (fstat(src, &opened) != 0) {
        int e = errno;
        close(src);
        errno = e;
        return -1;
    }
    /* Do not copy a replacement raced between fstatat() and openat(). */
    if (!S_ISREG(opened.st_mode) || opened.st_dev != st->st_dev || opened.st_ino != st->st_ino
        || opened.st_mode != st->st_mode || opened.st_size != st->st_size
        || opened.st_mtim.tv_sec != st->st_mtim.tv_sec || opened.st_mtim.tv_nsec != st->st_mtim.tv_nsec
        || opened.st_ctim.tv_sec != st->st_ctim.tv_sec || opened.st_ctim.tv_nsec != st->st_ctim.tv_nsec) {
        close(src);
        errno = EAGAIN;
        return -1;
    }
    int parent = -1;
    char *leaf = NULL;
    if (open_target_parent(newdirfd, newpath, &parent, &leaf) != 0) {
        int e = errno;
        close(src);
        errno = e;
        return -1;
    }
    struct stat existing;
    if (fstatat(parent, leaf, &existing, AT_SYMLINK_NOFOLLOW) == 0) {
        close(parent);
        free(leaf);
        close(src);
        errno = EEXIST;
        return -1;
    }
    if (errno != ENOENT) {
        int e = errno;
        close(parent);
        free(leaf);
        close(src);
        errno = e;
        return -1;
    }
    char temporary[96];
    int dst = -1;
    for (unsigned int attempt = 0; attempt < 128; attempt++) {
        uint64_t sequence = __sync_add_and_fetch(&link_temp_sequence, 1);
        int length = snprintf(temporary, sizeof(temporary), ".pocket-harness-link-%ld-%" PRIu64,
                              (long) getpid(), sequence);
        if (length < 0 || (size_t) length >= sizeof(temporary)) {
            errno = ENAMETOOLONG;
            break;
        }
        dst = openat(parent, temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
        if (dst >= 0 || errno != EEXIST) break;
    }
    if (dst < 0) {
        int e = errno;
        close(parent);
        free(leaf);
        close(src);
        errno = e;
        return -1;
    }
    size_t cap = 1 << 20;
    char *buf = malloc(cap);
    int rc = buf == NULL ? -1 : 0;
    int temporary_exists = 1;
    uint64_t copied = 0;
    if (buf == NULL) errno = ENOMEM;
    while (rc == 0) {
        ssize_t n = read(src, buf, cap);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { rc = -1; break; }
        if (n == 0) break;
        if ((uint64_t) n > (uint64_t) DSH_LINK_COPY_MAX_BYTES - copied) {
            errno = EFBIG;
            rc = -1;
            break;
        }
#ifdef DSH_LINK_TEST_FAIL_AFTER_BYTES
        if (copied >= DSH_LINK_TEST_FAIL_AFTER_BYTES) { errno = EIO; rc = -1; break; }
        size_t write_size = (size_t) n;
        if (write_size > DSH_LINK_TEST_FAIL_AFTER_BYTES - copied) {
            write_size = (size_t) (DSH_LINK_TEST_FAIL_AFTER_BYTES - copied);
        }
#else
        size_t write_size = (size_t) n;
#endif
#ifdef DSH_LINK_TEST_STOP_AFTER_BYTES
        if (copied >= DSH_LINK_TEST_STOP_AFTER_BYTES) raise(SIGSTOP);
        if (write_size > DSH_LINK_TEST_STOP_AFTER_BYTES - copied) {
            write_size = (size_t) (DSH_LINK_TEST_STOP_AFTER_BYTES - copied);
        }
#endif
        if (write_all(dst, buf, write_size) != 0) { rc = -1; break; }
        copied += write_size;
#ifdef DSH_LINK_TEST_FAIL_AFTER_BYTES
        if (copied >= DSH_LINK_TEST_FAIL_AFTER_BYTES) { errno = EIO; rc = -1; break; }
#endif
#ifdef DSH_LINK_TEST_STOP_AFTER_BYTES
        if (copied >= DSH_LINK_TEST_STOP_AFTER_BYTES) raise(SIGSTOP);
#endif
    }
    free(buf);
    if (rc == 0) {
        struct stat after;
        if (fstat(src, &after) != 0) rc = -1;
        else if (after.st_dev != opened.st_dev || after.st_ino != opened.st_ino
                 || after.st_size != opened.st_size || after.st_mtim.tv_sec != opened.st_mtim.tv_sec
                 || after.st_mtim.tv_nsec != opened.st_mtim.tv_nsec || after.st_ctim.tv_sec != opened.st_ctim.tv_sec
                 || after.st_ctim.tv_nsec != opened.st_ctim.tv_nsec) {
            errno = EAGAIN;
            rc = -1;
        }
    }
    if (rc == 0) {
        /* Same permissions (the create mask may have trimmed them) and timestamps. */
        if (fchmod(dst, st->st_mode & 07777) != 0) rc = -1;
        if (rc == 0) {
            struct timespec times[2] = { opened.st_atim, opened.st_mtim };
            if (futimens(dst, times) != 0) rc = -1;
        }
        if (rc == 0 && fsync(dst) != 0) rc = -1;
    }
    int e = errno;
    close(src);
    if (close(dst) != 0 && rc == 0) { rc = -1; e = errno; }
    if (rc == 0) {
        if (sys_renameat2(parent, temporary, parent, leaf, RENAME_NOREPLACE) != 0) {
            rc = -1;
            e = errno;
        } else {
            temporary_exists = 0;
        }
    }
    if (temporary_exists) unlinkat(parent, temporary, 0);
    close(parent);
    free(leaf);
    errno = e;
    return rc;
}

/* What link() does on a filesystem that has no hard links: a copy. */
static int emulate_link(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, int flags) {
    int follow = (flags & AT_SYMLINK_FOLLOW) != 0;
    struct stat st;
    if (fstatat(olddirfd, oldpath, &st, follow ? 0 : AT_SYMLINK_NOFOLLOW) != 0) return -1;
    if (S_ISDIR(st.st_mode)) { errno = EPERM; return -1; }
    if (S_ISLNK(st.st_mode)) {
        char target[PATH_MAX];
        ssize_t n = readlinkat(olddirfd, oldpath, target, sizeof(target) - 1);
        if (n < 0) return -1;
        target[n] = '\0';
        return symlinkat(target, newdirfd, newpath);
    }
    if (S_ISFIFO(st.st_mode)) return mkfifoat(newdirfd, newpath, st.st_mode & 07777);
    if (S_ISREG(st.st_mode)) return copy_regular(olddirfd, oldpath, newdirfd, newpath, &st, follow);
    /* Devices and sockets cannot be copied; report what the kernel said. */
    errno = EPERM;
    return -1;
}

int linkat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, int flags) {
    if (sys_linkat(olddirfd, oldpath, newdirfd, newpath, flags) == 0) return 0;
    if (errno != EPERM && errno != EACCES) return -1;
    int saved = errno;
    /* An empty oldpath (AT_EMPTY_PATH) names an open descriptor; leave that to the kernel. */
    if ((flags & AT_EMPTY_PATH) && oldpath[0] == '\0') { errno = saved; return -1; }
    return emulate_link(olddirfd, oldpath, newdirfd, newpath, flags);
}

int link(const char *oldpath, const char *newpath) {
    /* link(2) does not follow a symlink given as oldpath on Linux. */
    return linkat(AT_FDCWD, oldpath, AT_FDCWD, newpath, 0);
}

/* ---- dlopen("/proc/self/fd/N") ------------------------------------------------------------- */

typedef void *(*dlopen_fn)(const char *, int);

#ifndef DSH_DLFD_MAX_BYTES
#define DSH_DLFD_MAX_BYTES (1024LL * 1024LL * 1024LL)
#endif

/* Returns the descriptor number a /proc/{self,<pid>}/fd/N path names, or -1. */
static int proc_fd(const char *path) {
    const char *rest;
    if (strncmp(path, "/proc/self/fd/", 14) == 0) {
        rest = path + 14;
    } else if (strncmp(path, "/proc/", 6) == 0) {
        char *end;
        long pid = strtol(path + 6, &end, 10);
        if (end == path + 6 || pid != (long) getpid() || strncmp(end, "/fd/", 4) != 0) return -1;
        rest = end + 4;
    } else {
        return -1;
    }
    char *end;
    long fd = strtol(rest, &end, 10);
    if (end == rest || *end != '\0' || fd < 0) return -1;
    return (int) fd;
}

/* Copies the whole of [fd] into a new temp file; returns its path in [out] or -1. */
static int copy_out(int fd, char *out, size_t cap) {
    struct stat before;
    if (fstat(fd, &before) != 0) return -1;
    if (!S_ISREG(before.st_mode)) { errno = EINVAL; return -1; }
    if (before.st_size < 0 || before.st_size > DSH_DLFD_MAX_BYTES) { errno = EFBIG; return -1; }
    const char *dir = getenv("TMPDIR");
    if (dir == NULL || *dir == '\0') dir = "/tmp";
    size_t len = strlen(dir);
    if (len + sizeof("/.dlfd-XXXXXX") > cap) return -1;
    memcpy(out, dir, len);
    memcpy(out + len, "/.dlfd-XXXXXX", sizeof("/.dlfd-XXXXXX"));
    int dst = mkostemp(out, O_CLOEXEC);
    if (dst < 0) return -1;

    char buf[1 << 16];
    off_t off = 0;
    for (;;) {
        ssize_t n = pread(fd, buf, sizeof(buf), off);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) goto fail;
        if (n == 0) break;
        if (off > DSH_DLFD_MAX_BYTES - n) { errno = EFBIG; goto fail; }
        if (write_all(dst, buf, (size_t) n) != 0) goto fail;
        off += n;
    }
    struct stat after;
    if (fstat(fd, &after) != 0) goto fail;
    if (after.st_dev != before.st_dev || after.st_ino != before.st_ino || after.st_size != before.st_size
        || after.st_mtim.tv_sec != before.st_mtim.tv_sec || after.st_mtim.tv_nsec != before.st_mtim.tv_nsec
        || after.st_ctim.tv_sec != before.st_ctim.tv_sec || after.st_ctim.tv_nsec != before.st_ctim.tv_nsec) {
        errno = EAGAIN;
        goto fail;
    }
    close(dst);
    return 0;
fail:
    close(dst);
    unlink(out);
    return -1;
}

void *dlopen(const char *path, int flags) {
    static dlopen_fn real;
    if (real == NULL) real = (dlopen_fn) dlsym(RTLD_NEXT, "dlopen");

    int fd = path != NULL ? proc_fd(path) : -1;
    if (fd < 0) return real(path, flags);

    char copy[4096];
    if (copy_out(fd, copy, sizeof(copy)) != 0) {
        if (errno == EFBIG) return NULL;
        return real(path, flags);
    }
    void *handle = real(copy, flags);
    unlink(copy);
    return handle;
}
