output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "service_security_group_id" {
  value = aws_security_group.service.id
}

output "data_security_group_id" {
  value = aws_security_group.data.id
}
