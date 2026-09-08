import { z } from 'zod';
import { CompanyWireSchema } from '../../models/company';
import { DepartmentWireSchema } from '../../models/department';
import { EmployeeSchema } from '../../models/employee';
import { IdSchema } from '../../models/ids';
import {
  EmptyInputSchema,
  IdInputSchema,
  OkOutputSchema,
  listOutputSchema,
  nullableGetOutputSchema,
} from './common';

export const Company = {
  get: { input: EmptyInputSchema, output: nullableGetOutputSchema(CompanyWireSchema) },
  update: {
    input: z.object({ name: z.string().min(1).optional(), homePath: z.string().min(1).optional() }),
    output: z.object({ item: CompanyWireSchema }),
  },
  hire: {
    input: z.object({ roleKey: z.string().min(1), name: z.string().min(1).optional() }),
    output: z.object({ item: EmployeeSchema }),
  },
  fire: { input: IdInputSchema, output: OkOutputSchema },
  rename: { input: z.object({ id: IdSchema, name: z.string().min(1) }), output: OkOutputSchema },
  moveDesk: {
    input: z.object({ id: IdSchema, deskX: z.number().int(), deskY: z.number().int() }),
    output: OkOutputSchema,
  },
  listDepartments: { input: EmptyInputSchema, output: listOutputSchema(DepartmentWireSchema) },
  addDepartment: {
    input: z.object({ key: z.string().min(1), name: z.string().min(1) }),
    output: z.object({ item: DepartmentWireSchema }),
  },
  removeDepartment: { input: IdInputSchema, output: OkOutputSchema },
};
