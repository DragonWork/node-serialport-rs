// Copyright 2026 DragonWork
// SPDX-License-Identifier: Apache-2.0

#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <unistd.h>

int tcdrain(int fd) {
    int (*drain)(int) = dlsym(RTLD_NEXT, "tcdrain");
    if (getenv("SERIALPORT_GATE_DRAIN")) {
        int marker = open("entered", O_WRONLY | O_CREAT, 0600);
        if (marker < 0) return -1;
        close(marker);
        while (access("release", F_OK) != 0) {
            if (errno != ENOENT) return -1;
            usleep(1000);
        }
    }
    return drain(fd);
}
