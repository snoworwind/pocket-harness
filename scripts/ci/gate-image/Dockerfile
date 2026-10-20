# Local PR gate image: the same environment the PR Gate workflow expects.
#
# Why amd64 and not the host architecture: Google ships Android build-tools for Linux
# as x86-64 only, so `aidl` (needed by the Gradle AIDL task) cannot run in an arm64
# Linux image. On Apple Silicon this runs under Rosetta, which also matches the x64
# GitHub runner when the workflow is re-enabled.
#
# Versions mirror scripts/source-build/engine-toolchain.json and the workflow's
# setup-node / setup-python / setup-java inputs. Java is 17.0.20+8: the pinned
# "17.0.20+1" does not exist upstream (Adoptium publishes 17.0.20+8).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git gnupg unzip xz-utils zstd g++ make build-essential \
      python3 python3-venv python3-pip jq file tar procps openjdk-17-jdk-headless \
      sudo \
    && rm -rf /var/lib/apt/lists/*

# Node 24.21.0
RUN curl -fsSL --retry 3 -o /tmp/node.tar.xz "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz" \
 && mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 \
 && ln -sf /opt/node/bin/node /usr/local/bin/node \
 && ln -sf /opt/node/bin/npm /usr/local/bin/npm \
 && ln -sf /opt/node/bin/npx /usr/local/bin/npx \
 && npm install -g corepack@0.36.0 --ignore-scripts --no-audit --no-fund \
 && /opt/node/bin/corepack enable --install-directory /usr/local/bin

# Temurin 17 (Adoptium ships 17.0.20+8, not the 17.0.20+1 the toolchain policy names)
RUN curl -fsSL --retry 3 -o /tmp/jdk.tar.gz "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20%2B8/OpenJDK17U-jdk_x64_linux_hotspot_17.0.20_8.tar.gz" \
 && mkdir -p /opt/java && tar -xzf /tmp/jdk.tar.gz -C /opt/java --strip-components=1 \
 && ln -sfn /opt/java/bin/java /usr/local/bin/java \
 && ln -sfn /opt/java/bin/javac /usr/local/bin/javac

# Python 3.12.15 (the build actions/setup-python would install)
RUN curl -fsSL --retry 3 -o /tmp/py.tar.gz "https://github.com/actions/python-versions/releases/download/3.12.15-36805895057/python-3.12.15-linux-24.04-x64.tar.gz" \
 && mkdir -p /opt/python && tar -xzf /tmp/py.tar.gz -C /opt/python --strip-components=1 \
 && echo /opt/python/lib > /etc/ld.so.conf.d/python.conf && ldconfig \
 && ln -sf /opt/python/bin/python3 /usr/local/bin/python3

# Android SDK: platform 36 plus Linux build-tools used by the Kotlin gate
RUN curl -fsSL --retry 3 -o /tmp/cmd.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip \
 && unzip -q /tmp/cmd.zip -d /opt/android-sdk-cmdtools \
 && mkdir -p /opt/android-sdk/cmdline-tools \
 && mv /opt/android-sdk-cmdtools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
 && yes | /opt/android-sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root=/opt/android-sdk \
      "platforms;android-36" "build-tools;36.0.0" "build-tools;35.0.0" "platform-tools" > /tmp/sdk.log 2>&1

ENV JAVA_HOME=/opt/java \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/opt/java/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /workspace
