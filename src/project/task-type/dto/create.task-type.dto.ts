import { ApiModelProperty } from '@nestjs/swagger';
import { IsHexColor, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTaskTypeDto {
  @ApiModelProperty()
  @IsString()
  @MaxLength(40)
  @MinLength(3)
  @IsNotEmpty()
  title: string;

  @ApiModelProperty()
  @MaxLength(12)
  @MinLength(3)
  @IsString()
  @IsNotEmpty()
  icon: string;

  @ApiModelProperty()
  @IsHexColor()
  @IsString()
  @IsNotEmpty()
  color: string;
}