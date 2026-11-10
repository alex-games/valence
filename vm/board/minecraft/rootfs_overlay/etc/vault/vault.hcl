# Vault for the Minecraft VM.
#
# **PostgreSQL storage, not file and not dev mode.** Dev mode keeps every secret
# in RAM. The file backend kept Vault's data under /var/lib/vault/data, a second
# store beside PostgreSQL. Vault now uses the `vault_data` database in the same
# PostgreSQL cluster as the sidechain, so the warm-boot snapshot carries one
# persistent store. The bootstrap (unseal key, root token, game token) lives in
# `vault_bootstrap` in the `postgres` database.
#
# Loopback only, no TLS: the VM is disposable and the listener is never exposed
# outside the guest. A deployment beyond the demo puts TLS and an operator-unseal
# policy in front of this database.

storage "postgresql" {
  connection_url = "postgres://vault_user:vault@127.0.0.1:5432/vault_data?sslmode=disable"
  table          = "vault_kv_store"
  ha_enabled     = "false"
}

listener "tcp" {
  address     = "127.0.0.1:8200"
  tls_disable = 1
}

disable_mlock = true
ui            = false
api_addr      = "http://127.0.0.1:8200"
