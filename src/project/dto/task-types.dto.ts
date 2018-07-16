import { ApiModelProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, ArrayMinSize } from 'class-validator';

export class TaskTypesDto {
  @ApiModelProperty({ isArray: true, type: Number })
  @IsNotEmpty({ message: 'Добавьте хотя бы один тип задачи' })
  @IsNumber(undefined, { each: true })
  @ArrayMinSize(1)
  taskTypes: number[];
}
