package com.snoworwind.pocketharness

import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Test

/** DNS for Linux guests must follow Android's Private DNS privacy contract. */
class LinuxDnsPrivacyPolicyTest {
  private val resolver = InetAddress.getByName("1.1.1.1")

  @Test fun `active private dns never publishes plaintext resolver addresses`() {
    assertEquals(emptyList<InetAddress>(), selectLinuxDnsServers(28, true, listOf(resolver)))
    assertEquals(emptyList<InetAddress>(), selectLinuxDnsServers(36, true, listOf(resolver)))
  }

  @Test fun `inactive private dns and pre-p networks keep the supplied resolvers`() {
    assertEquals(listOf(resolver), selectLinuxDnsServers(28, false, listOf(resolver)))
    assertEquals(listOf(resolver), selectLinuxDnsServers(27, true, listOf(resolver)))
    assertEquals(emptyList<InetAddress>(), selectLinuxDnsServers(36, false, emptyList()))
  }
}
