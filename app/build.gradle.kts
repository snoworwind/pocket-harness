plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

val pocketReleaseSigningAvailable = !providers.environmentVariable("POCKET_SIGNING_KEYSTORE_PATH").orNull.isNullOrBlank() &&
  !providers.environmentVariable("POCKET_SIGNING_KEYSTORE_PASSWORD").orNull.isNullOrBlank()
val linuxNativeLibraryDir = providers.gradleProperty("linuxNativeLibraryDir").orNull

android {
  namespace = "com.snoworwind.pocketharness"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.snoworwind.pocketharness"
    minSdk = 26
    // Keep targetSdk 34 for the product's Android compatibility/security baseline.
    // Guest ELF execution is mediated by the APK-installed PRoot executable and
    // its static loader in nativeLibraryDir; writable app data holds guest files.
    targetSdk = 34
    // 0.14.8: the source-built engine moves to 0.2.1-rc.2; preserve monotonic upgrade identity.
    // All delivered APKs still require v1/v2/v3 signatures.
    versionCode = 52
    // Snapshot builds append a suffix (e.g. -SN-1-RC13) via -PversionNameSuffix; release builds pass none.
    val snapshotSuffix = providers.gradleProperty("versionNameSuffix").getOrElse("")
    // 版本号单一来源：UI（GuidePageRenderer）、桥（androidBridge.version）、诊断日志、引擎环境变量
    // （DSH_APP_VERSION，见 EngineManager.engineEnv）全部读这里，禁止任何地方再硬编码版本字面量。
    versionName = "0.14.8" + snapshotSuffix
    buildConfigField("String", "TERMUX_VERSION", "\"0.118.3\"")
    // 0.14.0-preview：虚拟屏 P0 建屏矩阵走仪器测试入口（app UID 下运行 = P0-6 要测的调用者身份），
    // 不新增任何产品面（Activity/Bridge/Manifest 均不动）。见 .deploy-tmp/iter-0140/vdisplay-p0.md §8.8。
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  buildFeatures {
    buildConfig = true
    // 0.14.0-preview：ShizukuUserService.aidl 生成 Stub（虚拟屏线 S5 的 bindUserService 需要）。
    // 惰性：当前无 Kotlin 引用该 aidl 时也不会产生额外产物。
    aidl = true
  }

  androidResources {
    // snapshot.tar.xz is already xz-compressed; double-compressing it breaks openFd.
    noCompress += "xz"
  }

  // Package the authenticated Termux PRoot executable, its static loader, and
  // required shared libraries as extracted APK native libraries. Android permits
  // execution from this PackageManager-owned location while blocking app-data ELF exec.
  packaging {
    jniLibs {
      useLegacyPackaging = true
      keepDebugSymbols += "**/libpocketharness_*.so"
      keepDebugSymbols += "**/libtalloc.so"
      keepDebugSymbols += "**/libandroid-shmem.so"
    }
  }

  signingConfigs {
    val signingStorePath = providers.environmentVariable("POCKET_SIGNING_KEYSTORE_PATH").orNull
    val signingStorePassword = providers.environmentVariable("POCKET_SIGNING_KEYSTORE_PASSWORD").orNull
    if (!signingStorePath.isNullOrBlank() && !signingStorePassword.isNullOrBlank()) {
      create("pocketRelease") {
        storeFile = file(signingStorePath)
        storeType = "PKCS12"
        storePassword = signingStorePassword
        keyAlias = "pocketharness"
        keyPassword = signingStorePassword
        enableV1Signing = true
        enableV2Signing = true
        enableV3Signing = true
      }
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig = signingConfigs.findByName("pocketRelease")
    }
    debug {
      // Developer builds use Gradle's local debug key. Distribution APKs are always release-signed.
      // Keep the all-schemes policy explicit for the debug variant too.
      signingConfig = signingConfigs.getByName("debug").apply {
        enableV1Signing = true
        enableV2Signing = true
        enableV3Signing = true
      }
    }
  }

  lint {
    // Offline environments lack the lint-gradle dependency cache (CN networks); lint is not on the release-critical path.
    checkReleaseBuilds = false
    abortOnError = false
  }

  testOptions {
    // Snapshot extraction/tests touch android.util.Log; default stubs keep the JVM
    // unit tests runnable without Robolectric.
    unitTests.isReturnDefaultValues = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions {
    jvmTarget = "17"
  }
}

if (!linuxNativeLibraryDir.isNullOrBlank()) {
  android.sourceSets.getByName("main").jniLibs.srcDir(file(linuxNativeLibraryDir))
}

tasks.configureEach {
  if (name == "mergeReleaseNativeLibs" && !linuxNativeLibraryDir.isNullOrBlank()) {
    doFirst {
      val libraryRoot = file(linuxNativeLibraryDir)
      for (name in listOf("libpocketharness_proot.so", "libpocketharness_proot_loader.so", "libtalloc.so", "libandroid-shmem.so")) {
        val library = libraryRoot.resolve("arm64-v8a/$name")
        if (!library.isFile || !library.canExecute()) {
          throw GradleException("Missing executable Linux APK native library: $library")
        }
      }
    }
  }
  if (name == "validateSigningRelease") {
    doFirst {
      if (!pocketReleaseSigningAvailable) {
        throw GradleException("Release signing requires POCKET_SIGNING_KEYSTORE_PATH and POCKET_SIGNING_KEYSTORE_PASSWORD")
      }
    }
  }
}

// The runtime snapshot comes from the source-build pipeline; the build fails with fetch guidance when it is missing.
tasks.whenTaskAdded {
  if (name == "mergeDebugAssets" || name == "mergeReleaseAssets") {
    doFirst {
      val snap = file("src/main/assets/snapshot.tar.xz")
      if (!snap.exists()) {
        throw GradleException(
          "缺少运行时快照 assets/snapshot.tar.xz —— " +
          "请按 ARM64 来源链生成并放入 app/src/main/assets/snapshot.tar.xz（见 README.md）",
        )
      }
    }
  }
}

dependencies {
  // Shizuku 特权通道（0.14.0-preview 虚拟屏线 P0-0）：Maven Central 13.1.5（2023-09-21；上游
  // App 仍更新但库停更，只按 13.1.5 API 面写代码）。许可 MIT（aar POM <licenses> 实测），
  // minSdk 26 >= aar 的 24/23，无需 desugaring；settings.gradle.kts 已有 mavenCentral()。
  implementation("dev.rikka.shizuku:api:13.1.5")
  implementation("dev.rikka.shizuku:provider:13.1.5")
  implementation("androidx.activity:activity-ktx:1.10.1")
  // 隔离浏览器身份面（0.14.0 正式轮）：document-start 脚本注入（platform/触摸/屏幕，无竞态）
  // 与 UA-CH（WebView >= 116 能力门）。无该库时只能用 onPageStarted 注入（有竞态）。
  implementation("androidx.webkit:webkit:1.12.1")
  // androidx.core: FileProvider (external-reader open, issue #52); ViewCompat/
  // WindowInsetsCompat were previously satisfied transitively via activity-ktx.
  implementation("androidx.core:core-ktx:1.15.0")
  // 悬浮球 v2 动效（PRD-overlay-v2 §3.5）：Material 3 Expressive spring 物理（Android 16 原生适配）
  implementation("androidx.dynamicanimation:dynamicanimation:1.1.0")
  implementation("org.apache.commons:commons-compress:1.28.0")
  implementation("org.tukaani:xz:1.10")
  testImplementation("junit:junit:4.13.2")
  // 仪器测试（虚拟屏建屏矩阵）：只用于 P0 探针，不进产品面。
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
  androidTestImplementation("androidx.test:runner:1.6.2")
  // 本地单测用真实 org.json（android.jar 桩在 JVM 里抛 Stub!）——快照 profiles 合并（#167）测试需要
  testImplementation("org.json:json:20240303")
}
