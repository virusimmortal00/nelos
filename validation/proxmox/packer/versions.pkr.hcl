packer {
  required_version = "= 1.15.4"

  required_plugins {
    proxmox = {
      source  = "github.com/hashicorp/proxmox"
      version = "= 1.2.4"
    }
  }
}
