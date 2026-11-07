# Vault for the Minecraft VM.
#
# **File storage, not dev mode.** Dev mode keeps every secret in RAM, so a warm
# boot restores an empty Vault and every player's game state is gone. The file
# backend under /var/lib/vault is part of the guest's persistent tree and is
# therefore included in the warm-boot snapshot.
#
# Loopback only, no TLS: the VM is disposable and the listener is never exposed
# outside the guest. A deployment beyond the demo puts TLS and an operator-unseal
# policy in front of this file.

storage "file" {
  path = "/var/lib/vault/data"
}

listener "tcp" {
  address     = "127.0.0.1:8200"
  tls_disable = 1
}

disable_mlock = true
ui            = false
api_addr      = "http://127.0.0.1:8200"
