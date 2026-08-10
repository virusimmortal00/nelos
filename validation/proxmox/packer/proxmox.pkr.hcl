source "proxmox-clone" "ubuntu_noble_validator" {
  # Authentication is intentionally not modeled as HCL variables. The plugin
  # reads PROXMOX_URL, PROXMOX_USERNAME, and PROXMOX_TOKEN from the environment.
  node = var.proxmox_node
  pool = var.proxmox_pool

  clone_vm_id = var.base_template_vmid
  full_clone  = true

  vm_id         = var.output_template_vmid
  vm_name       = var.output_template_name
  template_name = var.output_template_name
  template_description = join(" ", [
    "Nelos plugin validator; Ubuntu 24.04 amd64;",
    "PVE 8.4; q35/OVMF; x86-64-v2-AES; built from pinned inputs."
  ])

  task_timeout = "20m"
  tags         = "nelos-validator;ubuntu-24-04;packer;nelos-build-${substr(var.build_nonce, 0, 12)}"

  os                 = "l26"
  machine            = "q35"
  bios               = "ovmf"
  cpu_type           = "x86-64-v2-AES"
  sockets            = 1
  cores              = 4
  memory             = 8192
  ballooning_minimum = 0
  numa               = false

  boot            = "order=scsi0"
  scsi_controller = "virtio-scsi-single"
  qemu_agent      = true
  onboot          = false

  serials = ["socket"]
  vga {
    type = "serial0"
  }

  # Egress enforcement is supplied by the preconfigured nelosbld VNet. The
  # build wrapper requires a fresh operator readiness receipt before Packer.
  network_adapters {
    model         = "virtio"
    bridge        = "nelosbld"
    packet_queues = 4
    firewall      = true
  }

  ipconfig {
    ip = "dhcp"
  }

  # The plugin removes build-time Cloud-Init credentials and the source drive,
  # then creates a fresh empty drive after provisioning.
  cloud_init                          = true
  cloud_init_storage_pool             = var.cloud_init_storage
  cloud_init_disk_type                = "ide"
  cloud_init_disable_upgrade_packages = true

  communicator              = "ssh"
  ssh_username              = "ubuntu"
  ssh_timeout               = "20m"
  ssh_handshake_attempts    = 100
  ssh_clear_authorized_keys = true
  skip_convert_to_template  = false
  insecure_skip_tls_verify  = false
}
