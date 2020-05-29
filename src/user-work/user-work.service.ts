import { PaginationDto } from '@common/dto';
import { ForbiddenException, Injectable, NotAcceptableException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Project } from '@orm/project';
import { User } from '@orm/user';
import { ACCESS_LEVEL } from '@orm/user-project';
import { ValidationError } from 'class-validator';
import * as moment from 'moment';
import { DeleteResult, EntityManager, IsNull } from 'typeorm';

import { ValidationException } from '../@common/exceptions/validation.exception';
import { Task, TASK_SIMPLE_STATUS } from '../@orm/task';
import { TaskType } from '../@orm/task-type/task-type.entity';
import { UserTask } from '../@orm/user-task';
import { UserWork, UserWorkRepository } from '../@orm/user-work';
import { ProjectMemberService } from '../project/member/project.member.service';
import { ProjectService } from '../project/project.service';
import { ProjectTaskService } from '../project/task/project.task.service';
import { TaskService } from '../task/task.service';
import { UserService } from '../user/user.service';

import { StartResponse, StopResponse, UserWorkCreateDto, UserWorkEditResultDto, UserWorkPatchDto } from './dto';

@Injectable()
export class UserWorkService {
  constructor(
    @InjectRepository(UserWorkRepository) private readonly userWorkRepo: UserWorkRepository,
    private readonly projectService: ProjectService,
    private readonly projectTaskService: ProjectTaskService,
    private readonly userService: UserService,
    private readonly taskService: TaskService,
    private readonly projectMemberService: ProjectMemberService
  ) {}

  public findAll(pagesDto: PaginationDto, user: User): Promise<UserWork[]> {
    return this.userWorkRepo.findAllWithPagination(pagesDto, user);
  }

  public async findOneByUser(userWorkId: number, user: User): Promise<UserWork> {
    const userWork = await this.userWorkRepo.findOneByUser(userWorkId, user);
    if (!userWork) {
      throw new ForbiddenException('Вы можете менять время только своей работы');
    }
    return userWork;
  }

  public async findOneByUserAndCheckAccess(
    userWorkId: number,
    user: User,
    accessLevel: ACCESS_LEVEL = ACCESS_LEVEL.RED
  ): Promise<UserWork> {
    const userWork = await this.userWorkRepo.findOneByUser(userWorkId, user);
    if (!userWork) {
      throw new ForbiddenException('Вы пытаетесь изменить чужую работу');
    }
    const project = await this.projectService.findOneByMember(userWork.projectId, user);
    if (!project || !project.isAccess(accessLevel)) {
      throw new ForbiddenException('У вас нет доступа к проекту, к которому принадлежит эта задача');
    }
    return userWork;
  }

  public async updateTime(
    userWork: UserWork,
    user: User,
    recalculate: boolean = false,
    manager?: EntityManager
  ): Promise<UserWork> {
    const curManager = manager || this.userWorkRepo.manager;
    let res = userWork;
    if (!userWork.projectId || !userWork.task.userTasks) {
      userWork.task = await curManager.findOne(Task, {
        relations: ['performer', 'userTasks', 'project'],
        where: { id: userWork.taskId },
      });
    }
    if (userWork.finishAt && moment(userWork.startAt).diff(moment(userWork.finishAt)) > 0) {
      throw new NotAcceptableException('startAt не может быть позже, чем finishAt');
    }
    res = await curManager.save(UserWork, userWork);
    if (recalculate) {
      await this.projectService.calculateUserStatistic(user, 0, curManager);
    } else {
      await this.projectMemberService.addTime(userWork, curManager);
    }
    return res;
  }

  public async remove(userWork: UserWork, user): Promise<DeleteResult | undefined> {
    let result: DeleteResult;
    await this.userWorkRepo.manager.transaction(async entityManager => {
      result = await entityManager.delete(UserWork, { id: userWork.id });
      await this.projectService.calculateUserStatistic(user, 0, entityManager);
    });
    return result;
  }

  public async finishTask(
    curManager: EntityManager,
    userWork: UserWork,
    user: User,
    status?: TASK_SIMPLE_STATUS
  ): Promise<UserWork> {
    userWork.finishAt = moment();
    if (!userWork.projectId || !userWork.task.userTasks) {
      userWork.task = await curManager.findOne(Task, {
        relations: ['performer', 'userTasks', 'project'],
        where: { id: userWork.taskId },
      });
    }
    if (typeof status === 'number') {
      userWork.task.status = status;
      await this.taskService.updateByUser(userWork.task, { status }, user, curManager);
    }
    const curUserTask = userWork.task.userTasks.find(el => el.userId === user.id);

    // TODO: проверить стратегию проекта

    if (!curUserTask) {
      // 1. create new userTask
      let userTask = new UserTask();
      userTask.task = { id: userWork.taskId } as Task;
      userTask.user = { id: user.id } as User;
      userTask.time = userWork.finishAt.diff(userWork.startAt);
      userTask = await curManager.save(userTask);
      userWork.task.userTasks.push(userTask);

      // 2. update all benefitParts
      await this.updateBenefitParts(userWork.task.userTasks, curManager);
    } else {
      curUserTask.time += userWork.finishAt.diff(userWork.startAt);
      await curManager.save(curUserTask);
    }

    if (curUserTask && !curUserTask.benefitPart) {
      // 2. update all benefitParts
      await this.updateBenefitParts(userWork.task.userTasks, curManager);
    }

    return await this.updateTime(userWork, user, false, curManager);
  }

  public async updateBenefitParts(userTasks: UserTask[], manager?: EntityManager): Promise<void> {
    const curManager = manager || this.userWorkRepo.manager;
    const usersCount = userTasks.length;
    userTasks.map(ut => {
      const accuracy = 1000000;
      ut.benefitPart = Math.round(accuracy / usersCount) / accuracy;
    });
    await curManager.save(userTasks);
  }

  public async finishNotFinished(user: User, manager?: EntityManager): Promise<UserWork[]> {
    const curManager = manager || this.userWorkRepo.manager;
    const userWorks = await curManager.find(UserWork, {
      relations: ['task', 'task.userTasks'],
      where: { finishAt: IsNull(), user },
    });

    return await Promise.all(
      userWorks.map(async userWork => {
        return await this.finishTask(manager, userWork, user, TASK_SIMPLE_STATUS.IN_TESTING);
      })
    );
  }

  public async start(project: Project, user: User, userWorkData: UserWorkCreateDto): Promise<StartResponse> {
    const result: StartResponse = {
      finished: [],
      started: null,
    };
    await this.userWorkRepo.manager.transaction(async entityManager => {
      // TODO: добавить транзакции на процесс создания всех частей задачи
      // 1. Завершить предыдущие задачи, если есть незавершенные
      result.finished = await this.finishNotFinished(user, entityManager);

      // 2. Создать новую задачу
      let startAt;
      if (result.finished && result.finished.length) {
        startAt = result.finished[0].finishAt;
      }
      result.started = await this.startNew(project, user, userWorkData, startAt, entityManager);
    });

    return result;
  }

  public async stop(userWork: UserWork, user: User): Promise<StopResponse> {
    if (userWork.finishAt) {
      throw new NotAcceptableException('Эта задача уже завершена. Вы не можете завершить одну и ту же задачу дважды');
    }
    const result: StopResponse = {
      next: null,
      previous: null,
    };
    await this.userWorkRepo.manager.transaction(async entityManager => {
      result.previous = await this.finishTask(entityManager, userWork, user, TASK_SIMPLE_STATUS.IN_TESTING);

      const project = await this.userService.getDefaultProject(user, entityManager);

      const userWorkData = {
        description: `После "${result.previous.task.title}"`,
        projectId: project.id,
        title: 'Перерыв/Отдых',
      };
      result.next = await this.startNew(project, user, userWorkData, result.previous.finishAt, entityManager);
    });
    return result;
  }

  public async pause(userWork: UserWork, user: User): Promise<StopResponse> {
    if (userWork.finishAt) {
      throw new NotAcceptableException('Эта задача уже завершена. Вы не можете завершить одну и ту же задачу дважды');
    }

    const stopResponse: StopResponse = {
      next: null,
      previous: null,
    };
    await this.userWorkRepo.manager.transaction(async manager => {
      stopResponse.previous = await this.finishTask(manager, userWork, user, TASK_SIMPLE_STATUS.TO_DO);

      const project = await this.userService.getDefaultProject(user, manager);

      const userWorkData = {
        description: `После "${stopResponse.previous.task.title}"`,
        projectId: project.id,
        title: 'Перерыв/Отдых',
        prevTaskId: userWork.taskId,
      };
      stopResponse.next = await this.startNew(project, user, userWorkData, stopResponse.previous.finishAt, manager);
      stopResponse.next.prevTask = userWork.task;
    });

    return stopResponse;
  }

  public async update(userWork: UserWork, userWorkDto: UserWorkPatchDto, user: User): Promise<UserWorkEditResultDto> {
    // 0. Обернуть выполнение в транзакцию
    let removed = [];
    let touched = [];
    if (userWorkDto.startAt || userWorkDto.finishAt) {
      // 1. найти все задачи, затрагивающие этот промежуток времени
      const touchedUserWorks = await this.userWorkRepo.findAllTouchedBetween(
        userWork,
        user,
        userWorkDto.startAt ? moment(userWorkDto.startAt) : userWork.startAt,
        userWorkDto.finishAt ? moment(userWorkDto.finishAt) : userWork.finishAt
      );

      // 2. удалить все задачи, полностью включенные в этот промежуток времени
      removed = touchedUserWorks.filter(
        el =>
          el.startAt.diff(userWorkDto.startAt ? moment(userWorkDto.startAt) : userWork.startAt) >= 0 &&
          (el.finishAt
            ? el.finishAt.diff(userWorkDto.finishAt ? moment(userWorkDto.finishAt) : userWork.finishAt || moment()) <= 0
            : !userWorkDto.finishAt)
      );
      if (removed.length) {
        for (const uw of removed) {
          await this.remove(uw, user);
        }
      }

      // 3. изменить все задачи, которые затрагивает этот промежуток времени
      touched = touchedUserWorks.filter((tuw: any) => removed.findIndex(el => el.id === tuw.id) === -1);
      if (touched.length) {
        touched = touched.map(el => {
          if (
            el.startAt &&
            userWorkDto.finishAt &&
            el.startAt.diff(moment(userWorkDto.finishAt)) < 0 &&
            el.startAt.diff(moment(userWorkDto.startAt)) >= 0
          ) {
            el.startAt = moment(userWorkDto.finishAt);
          }

          if (
            el.finishAt &&
            el.finishAt.diff(moment(userWorkDto.startAt)) > 0 &&
            (!userWorkDto.finishAt || el.finishAt.diff(moment(userWorkDto.finishAt)) <= 0)
          ) {
            el.finishAt = moment(userWorkDto.startAt);
          }

          return el;
        });
        for (const uw of touched) {
          await this.updateTime(uw, user, true);
        }
      }
    }

    // 4. изменить изменяемую задачу
    if (userWork.taskId !== userWorkDto.taskId) {
      try {
        // try to find task and check user access to this task
        userWork.task = await this.taskService.findOneById(userWorkDto.taskId, user);
      } catch (e) {
        throw new ValidationException(
          [
            Object.assign(new ValidationError(), {
              constraints: {
                isNotFound: 'Задача, соответствующая этому taskId не была найдена',
              },
              property: 'taskId',
              value: userWorkDto.taskId,
            }),
          ],
          'Задача не найдена'
        );
      }
    }
    const updateUserWork = this.userWorkRepo.merge(userWork, userWorkDto);
    const edited = await this.updateTime(updateUserWork, user, true);

    // prepare correct userTasks before returning response
    for (const rem of removed) {
      rem.task = await this.taskService.findOneByIdWithUserTasks(rem.taskId);
    }
    for (const touch of touched) {
      touch.task = await this.taskService.findOneByIdWithUserTasks(touch.taskId);
    }
    edited.task = await this.taskService.findOneByIdWithUserTasks(edited.taskId);

    return {
      edited,
      removed,
      touched,
    };
  }

  public recent(user: User, pagesDto: PaginationDto): Promise<UserWork[]> {
    return this.userWorkRepo.findWithPaginationByUser(user, pagesDto);
  }

  public async findAllByTaskSequenceNumber(
    project: Project,
    user: User,
    sequenceNumber: number,
    { skip = 0, count = 20, orderBy = 'startAt', order = 'desc' }: PaginationDto
  ): Promise<UserWork[]> {
    const checkedTask = await this.projectTaskService.checkAccess(sequenceNumber, project, user);

    return await this.userWorkRepo.find({
      order: { [orderBy]: order.toUpperCase() },
      relations: ['task'],
      skip,
      take: count,
      where: {
        taskId: checkedTask.id,
      },
    });
  }

  private async startNew(
    project: Project,
    user: User,
    userWorkData: UserWorkCreateDto,
    startAt: moment.Moment,
    manager?: EntityManager
  ): Promise<UserWork> {
    const curManager = manager || this.userWorkRepo.manager;
    let startedTask;
    if (userWorkData.taskId) {
      startedTask = await this.taskService.findOneById(
        userWorkData.taskId,
        user,
        undefined,
        undefined,
        undefined,
        curManager
      );
      if (!startedTask) {
        throw new NotFoundException(`Указанная задача ${userWorkData.taskId} не найдена в проекте ${project.title}`);
      }
    }
    if (startedTask) {
      if (startedTask.status !== TASK_SIMPLE_STATUS.IN_PROGRESS) {
        startedTask = await this.taskService.updateByUser(
          startedTask,
          { status: TASK_SIMPLE_STATUS.IN_PROGRESS },
          user,
          curManager
        );
      }
    } else {
      const taskType = await curManager.findOne(TaskType, { name: 'feature' });
      const taskData = {
        description: userWorkData.description || '',
        performerId: userWorkData.performerId || user.id,
        status: TASK_SIMPLE_STATUS.IN_PROGRESS,
        typeId: taskType ? taskType.id : undefined,
        title: userWorkData.title,
      };
      startedTask = await this.taskService.createByProject(taskData, project, user, curManager);
    }
    return await this.userWorkRepo.startTask(
      startedTask,
      user,
      {
        description: userWorkData.description,
        prevTaskId: userWorkData.prevTaskId,
      },
      startAt,
      curManager
    );
  }
}
