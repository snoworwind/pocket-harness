package com.snoworwind.pocketharness

import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files

class LinuxFileTreeTest {
  @get:Rule val temporary = TemporaryFolder()
  @Test fun seedAddsFilesWithoutOverwritingUserProfilesOrCredentials() {
    val source = temporary.newFolder(); val target = temporary.newFolder()
    File(source, "home/.dsh/profiles/web").mkdirs(); File(target, "home/.dsh/profiles/web").mkdirs()
    File(source, "home/.dsh/profiles/web/package.json").writeText("factory")
    File(target, "home/.dsh/profiles/web/package.json").writeText("user plugins")
    File(source, "home/.gitconfig").writeText("factory git")
    File(target, "home/.gitconfig").writeText("user git")
    File(source, "home/.dsh/new-default").writeText("new")
    File(target, "home/.dsh/.credentials.yaml").writeText("private")
    LinuxFileTree.mergeMissing(source, target)
    LinuxFileTree.mergeMissing(source, target)
    assertEquals("user plugins", File(target, "home/.dsh/profiles/web/package.json").readText())
    assertEquals("user git", File(target, "home/.gitconfig").readText())
    assertEquals("new", File(target, "home/.dsh/new-default").readText())
    assertEquals("private", File(target, "home/.dsh/.credentials.yaml").readText())
  }
  @Test fun seedCannotWriteThroughAnExistingParentSymlink() {
    val source = temporary.newFolder(); val target = temporary.newFolder(); val external = temporary.newFolder()
    File(source, "home/.dsh").mkdirs(); File(source, "home/.dsh/settings.yaml").writeText("factory")
    File(target, "home").mkdirs(); Files.createSymbolicLink(File(target, "home/.dsh").toPath(), external.toPath())
    LinuxFileTree.mergeMissing(source, target)
    assertFalse(File(external, "settings.yaml").exists())
  }
  @Test fun treeDigestDetectsModifiedMissingExtraAndRetargetedEntries() {
    val root = temporary.newFolder(); File(root, "bin").mkdirs(); val node = File(root, "bin/node").apply { writeText("good") }
    Files.createSymbolicLink(File(root, "node").toPath(), java.nio.file.Paths.get("bin/node"))
    val expected = LinuxFileTree.digest(root)
    node.writeText("evil"); assertNotEquals(expected, LinuxFileTree.digest(root)); node.writeText("good")
    assertEquals(expected, LinuxFileTree.digest(root))
    val extra = File(root, "extra").apply { writeText("extra") }; assertNotEquals(expected, LinuxFileTree.digest(root)); extra.delete()
    Files.delete(File(root, "node").toPath()); Files.createSymbolicLink(File(root, "node").toPath(), java.nio.file.Paths.get("outside"))
    assertNotEquals(expected, LinuxFileTree.digest(root))
  }
  @Test fun glibcPreflightRejectsOlderAndMalformedVersions() {
    assertTrue(LinuxCandidateProbe.glibcSatisfies("glibc 2.41\n", "2.41"))
    assertTrue(LinuxCandidateProbe.glibcSatisfies("glibc 2.42", "2.41"))
    assertFalse(LinuxCandidateProbe.glibcSatisfies("glibc 2.40", "2.41"))
    assertFalse(LinuxCandidateProbe.glibcSatisfies("not glibc", "2.41"))
    assertFalse(LinuxCandidateProbe.glibcSatisfies("glibc 2.41", "bad"))
  }
  @Test fun shellIdentityMigrationPreservesUserConfigurationAndUnknownRows() {
    val legacy = """- insert:
    - id: shell-termux
      name: '@dsh-android/dsh-shell-termux'
      config:
        home: /home/custom
        timeoutMs: 321
    - id: shell-termux-custom
      name: user-shell
"""
    val migrated = LinuxFileTree.migrateShellIdentity(legacy)
    assertTrue(migrated.contains("- id: shell-linux"))
    assertTrue(migrated.contains("name: '@dsh-android/dsh-shell-linux'"))
    assertTrue(migrated.contains("home: /home/custom"))
    assertTrue(migrated.contains("timeoutMs: 321"))
    assertTrue(migrated.contains("- id: shell-termux-custom"))
    assertEquals(migrated, LinuxFileTree.migrateShellIdentity(migrated))
    val custom = "- id: shell-termux\n  name: user-owned-shell\n"
    assertEquals(custom, LinuxFileTree.migrateShellIdentity(custom))
  }

  @Test fun shellIdentityMigrationRejectsLinkedProfilesWithoutChangingTheTarget() {
    val home = temporary.newFolder()
    val external = temporary.newFolder()
    val patch = File(external, "cordis.patch.yml").apply { writeText("user-owned") }
    File(home, ".dsh/profiles").mkdirs()
    Files.createSymbolicLink(File(home, ".dsh/profiles/web").toPath(), external.toPath())
    assertTrue(runCatching { LinuxFileTree.migrateHomeShellIdentity(home) }.isFailure)
    assertEquals("user-owned", patch.readText())
  }

}
