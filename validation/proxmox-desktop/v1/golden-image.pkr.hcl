packer {
  required_version = "= 1.15.4"
  required_plugins {
    proxmox = {
      version = "= 1.2.4"
      source  = "github.com/hashicorp/proxmox"
    }
  }
}

variable "source_template_vmid" {
  type = number
  validation {
    condition     = var.source_template_vmid == 9024
    error_message = "source template VMID must be fixed at 9024"
  }
}

variable "output_template_vmid" {
  type = number
  validation {
    condition     = var.output_template_vmid == 9027
    error_message = "output template VMID must be fixed at 9027"
  }
}

variable "output_template_mac" {
  type = string
  validation {
    condition     = var.output_template_mac == "02:4E:45:4C:90:27"
    error_message = "output template MAC must use the fixed 9027 reservation"
  }
}

variable "proxmox_node" {
  type = string
}

variable "storage_pool" {
  type = string
}

variable "build_nonce" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.build_nonce))
    error_message = "build nonce must be exactly 32 lowercase hexadecimal characters"
  }
}

source "proxmox-clone" "desktop" {
  node                 = var.proxmox_node
  clone_vm_id          = var.source_template_vmid
  full_clone           = true
  vm_id                = var.output_template_vmid
  vm_name              = "nelos-desktop-ubuntu-24-04-v1"
  template_name        = "nelos-desktop-ubuntu-24-04-v1"
  template_description = "nelos-golden-v1:${var.build_nonce}"
  tags                 = "nelos-golden;nelos-build-${var.build_nonce}"
  machine              = "q35"
  bios                 = "ovmf"
  cpu_type             = "x86-64-v2-AES"
  sockets              = 1
  cores                = 4
  memory               = 8192
  qemu_agent           = true
  onboot               = false
  scsi_controller      = "virtio-scsi-single"
  vga { type = "virtio" }
  network_adapters {
    model       = "virtio"
    mac_address = var.output_template_mac
    bridge      = "nelosbld"
    firewall    = true
  }
  ipconfig {
    ip = "dhcp"
  }
  cloud_init                          = true
  cloud_init_storage_pool             = var.storage_pool
  cloud_init_disk_type                = "ide"
  cloud_init_disable_upgrade_packages = true
  communicator                        = "ssh"
  ssh_username                        = "ubuntu"
  ssh_timeout                         = "20m"
  ssh_handshake_attempts              = 100
  ssh_clear_authorized_keys           = true
  skip_convert_to_template            = false
  insecure_skip_tls_verify            = false
  task_timeout                        = "30m"
}

build {
  name    = "desktop"
  sources = ["source.proxmox-clone.desktop"]
  provisioner "file" {
    source      = "${path.root}/package-lock.json"
    destination = "/tmp/nelos-desktop-package-lock.json"
  }
  provisioner "file" {
    source      = "${path.root}/ubuntu.sources"
    destination = "/tmp/nelos-ubuntu.sources"
  }
  provisioner "file" {
    source      = "${path.root}/candidate-runtime.tar"
    destination = "/tmp/candidate-runtime.tar"
  }
  provisioner "file" {
    source      = "${path.root}/candidate-runtime.tar.sha256"
    destination = "/tmp/candidate-runtime.tar.sha256"
  }
  provisioner "file" {
    source      = "${path.root}/../../proxmox/desktop/helpers/"
    destination = "/tmp/nelos-desktop-helpers"
  }
  provisioner "file" {
    source      = "${path.root}/../../proxmox/desktop/recipe-v1/nelos-accessibility.desktop"
    destination = "/tmp/nelos-accessibility.desktop"
  }
  provisioner "file" {
    source      = "${path.root}/../../proxmox/desktop/recipe-v1/nelos-desktop-session.service"
    destination = "/tmp/nelos-desktop-session.service"
  }
  provisioner "file" {
    source      = "${path.root}/../../proxmox/desktop/recipe-v1/nelos-codex-desktop.service"
    destination = "/tmp/nelos-codex-desktop.service"
  }
  provisioner "file" {
    source      = "${path.root}/../../proxmox/desktop/recipe-v1/nelos-device-auth.service"
    destination = "/tmp/nelos-device-auth.service"
  }
  provisioner "file" {
    source      = "${path.root}/../../proxmox/desktop/recipe-v1/check-gui-readiness.sh"
    destination = "/tmp/nelos-check-gui-readiness"
  }
  provisioner "shell" {
    script          = "${path.root}/provision-golden-image.sh"
    execute_command = "chmod +x {{ .Path }}; sudo -n env PACKAGE_LOCK=/tmp/nelos-desktop-package-lock.json APT_SOURCES=/tmp/nelos-ubuntu.sources CANDIDATE_RUNTIME_ARCHIVE=/tmp/candidate-runtime.tar CANDIDATE_RUNTIME_SHA256=/tmp/candidate-runtime.tar.sha256 HELPER_SOURCE_DIR=/tmp/nelos-desktop-helpers ACCESSIBILITY_AUTOSTART=/tmp/nelos-accessibility.desktop SESSION_SERVICE=/tmp/nelos-desktop-session.service DESKTOP_USER_SERVICE=/tmp/nelos-codex-desktop.service DEVICE_AUTH_SERVICE=/tmp/nelos-device-auth.service READINESS_HELPER=/tmp/nelos-check-gui-readiness {{ .Path }}"
  }
}
