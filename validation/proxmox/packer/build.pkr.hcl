build {
  name = "nelos-ubuntu-noble-validator"

  sources = [
    "source.proxmox-clone.ubuntu_noble_validator",
  ]

  provisioner "file" {
    source      = "${path.root}/../toolchain.lock.json"
    destination = "/tmp/nelos-toolchain.lock.json"
  }

  provisioner "file" {
    source      = "${path.root}/../cloud-init/99-nelos-validator.cfg"
    destination = "/tmp/99-nelos-validator.cfg"
  }

  # The root-mutating guest scripts refuse to run unless this one-time marker
  # is created by the active Packer communicator and carries this build's UUID.
  provisioner "shell" {
    environment_vars = [
      "NELOS_PACKER_BUILD_NONCE=${var.build_nonce}",
    ]
    inline = [
      "install -d -m 0700 /run/nelos-packer-build",
      "printf '%s\\n' \"$NELOS_PACKER_BUILD_NONCE\" > /run/nelos-packer-build/authorized",
      "chmod 0600 /run/nelos-packer-build/authorized",
    ]
    execute_command = "chmod +x {{ .Path }}; sudo -n env {{ .Vars }} {{ .Path }}"
  }

  provisioner "shell" {
    script = "${path.root}/../scripts/provision-guest.sh"
    environment_vars = [
      "TOOLCHAIN_LOCK=/tmp/nelos-toolchain.lock.json",
      "CLOUD_INIT_POLICY=/tmp/99-nelos-validator.cfg",
      "NELOS_PACKER_BUILD_NONCE=${var.build_nonce}",
    ]
    execute_command = "chmod +x {{ .Path }}; sudo -n env {{ .Vars }} {{ .Path }}"
  }

  provisioner "shell" {
    script = "${path.root}/../scripts/prepare-template.sh"
    environment_vars = [
      "NELOS_PACKER_BUILD_NONCE=${var.build_nonce}",
    ]
    execute_command = "chmod +x {{ .Path }}; sudo -n env {{ .Vars }} {{ .Path }}"
  }
}
