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
}

variable "output_template_vmid" {
  type = number
}

variable "proxmox_node" {
  type = string
}

variable "storage_pool" {
  type = string
}

variable "ssh_username" {
  type    = string
  default = "ubuntu"
}

source "proxmox-clone" "desktop" {
  node          = var.proxmox_node
  clone_vm_id   = var.source_template_vmid
  full_clone    = true
  vm_id         = var.output_template_vmid
  vm_name       = "nelos-desktop-ubuntu-24-04-v1"
  template_name = "nelos-desktop-ubuntu-24-04-v1"
  machine       = "q35"
  bios          = "ovmf"
  cpu_type      = "x86-64-v2-AES"
  sockets       = 1
  cores         = 4
  memory        = 8192
  qemu_agent    = true
  onboot        = false
  scsi_controller = "virtio-scsi-single"
  disks {
    type         = "scsi"
    disk_size    = "64G"
    storage_pool = var.storage_pool
    io_thread    = true
    discard      = true
  }
  vga { type = "virtio" }
  network_adapters {
    model    = "virtio"
    bridge   = "nelosbld"
    firewall = true
  }
  communicator              = "ssh"
  ssh_username              = var.ssh_username
  ssh_clear_authorized_keys = true
  skip_convert_to_template  = false
}

build {
  sources = ["source.proxmox-clone.desktop"]
  provisioner "file" {
    source      = "${path.root}/package-lock.json"
    destination = "/tmp/nelos-desktop-package-lock.json"
  }
  provisioner "shell" {
    script          = "${path.root}/provision-golden-image.sh"
    execute_command = "chmod +x {{ .Path }}; sudo -n env PACKAGE_LOCK=/tmp/nelos-desktop-package-lock.json {{ .Path }}"
  }
}
