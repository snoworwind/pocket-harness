package com.snoworwind.pocketharness

import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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

  @Test fun `guest resolver uses published addresses and empty state never uses public dns`() {
    assertEquals("nameserver 10.0.2.3\nnameserver 2001:db8::53\noptions timeout:2 attempts:2\n",
      linuxResolverConfig(listOf("10.0.2.3", "2001:db8::53")))
    assertEquals("nameserver 127.0.0.1\noptions timeout:2 attempts:2\n", linuxResolverConfig(emptyList()))
    assertTrue(runCatching { linuxResolverConfig(listOf("10.0.2.3\nnameserver 8.8.8.8")) }.isFailure)
    assertTrue(runCatching { linuxResolverConfig(listOf("resolver.example.com")) }.isFailure)
  }
}
