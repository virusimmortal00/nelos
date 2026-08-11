variable "proxmox_node" {
  type        = string
  description = "Proxmox VE node that owns the node-local source template and build storage."
}

variable "proxmox_pool" {
  type        = string
  description = "Optional Proxmox resource pool for the ephemeral build VM and output template."
  default     = ""
}

variable "base_template_vmid" {
  type        = number
  description = "VMID of the pre-existing Ubuntu 24.04 Cloud-Init base template."
}

variable "base_template_name" {
  type        = string
  description = "Exact name of the retained base template verified by the guarded build wrapper."
}

variable "output_template_vmid" {
  type        = number
  description = "Reserved VMID for the output template. The guarded build wrapper refuses an existing VMID."
}

variable "output_template_name" {
  type        = string
  description = "DNS-safe name for the output template. The guarded build wrapper refuses an existing name."
}

variable "cloud_init_storage" {
  type        = string
  description = "Node-local Proxmox storage ID for the output template Cloud-Init drive."
}

variable "build_nonce" {
  type        = string
  description = "Wrapper-generated UUID that attests the one Packer guest allowed to run root provisioners."

  validation {
    condition     = can(regex("^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$", var.build_nonce))
    error_message = "Build nonce must be a lowercase RFC 4122 version 4 UUID."
  }
}
