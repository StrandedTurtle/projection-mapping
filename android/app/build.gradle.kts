plugins {
    id("com.android.application")
}

android {
    namespace = "app.projectionmapper.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.projectionmapper.tv"
        minSdk = 23
        targetSdk = 35
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.1." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
    }

    // A fixed key checked into the repo so every build (local or CI) can be
    // installed over the previous one without uninstalling (which would wipe
    // your saved mapping). It only signs this hobby app; it grants no access
    // to anything else. Swap it for your own if you publish the app.
    signingConfigs {
        create("shared") {
            storeFile = file("projection-mapper.keystore")
            storePassword = "projectionmapper"
            keyAlias = "projectionmapper"
            keyPassword = "projectionmapper"
        }
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("shared")
        }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shared")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    // The web app (projector page + phone controller) ships inside the APK.
    sourceSets {
        getByName("main") {
            assets.srcDirs("../../web")
        }
    }

    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

dependencies {
    implementation(project(":server"))
}
