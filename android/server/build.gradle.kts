// Pure-Java HTTP/WebSocket server shared by the TV app and the desktop jar.
plugins {
    `java-library`
}

java {
    sourceCompatibility = JavaVersion.VERSION_1_8
    targetCompatibility = JavaVersion.VERSION_1_8
}

tasks.withType<JavaCompile>().configureEach {
    options.compilerArgs.add("-Xlint:-options")
}

// `./gradlew :server:jar` -> runnable desktop server: java -jar server.jar --web ../web
tasks.jar {
    manifest { attributes["Main-Class"] = "app.projectionmapper.server.Main" }
}
