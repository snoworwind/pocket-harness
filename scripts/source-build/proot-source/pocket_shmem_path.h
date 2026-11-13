/* Pocket Harness source-build adapter. No package-specific compiled-in prefix. */
#ifndef POCKET_SHMEM_PATH_H
#define POCKET_SHMEM_PATH_H

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int pocket_shmem_key_path(char *buffer, size_t capacity, int key)
{
    const char *directory = getenv("PROOT_TMP_DIR");
    if (directory == NULL || directory[0] == '\0') directory = getenv("TMPDIR");
    if (buffer == NULL || capacity == 0 || directory == NULL || directory[0] != '/') {
        errno = EINVAL;
        return -1;
    }
    const char *separator = directory[strlen(directory) - 1] == '/' ? "" : "/";
    int length = snprintf(buffer, capacity, "%s%sashv_key_%d", directory, separator, key);
    if (length < 0 || (size_t)length >= capacity) {
        errno = ENAMETOOLONG;
        return -1;
    }
    return 0;
}

#endif
